'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const BASE_URL = config.base_url;
const WS_URL = config.ws_url;
const API_KEY = config.api_key;
const API_SECRET = config.api_secret;

// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  running: false,
  paused: false,
  capital: config.capital,
  startingCapital: config.capital,
  dailyLossLimit: config.daily_loss_limit_pct,
  maxTradeRiskPct: config.max_trade_risk_pct,
  emaFast: config.ema_fast,
  emaSlow: config.ema_slow,
  instruments: config.instruments,
  primaryExpiry: config.primary_expiry,
  maxOpenPositions: config.max_open_positions,
  tradeActiveHours: config.trade_active_hours,

  prices: { BTC: null, ETH: null },
  candles: { BTC: [], ETH: [] },
  ema: {
    BTC: { fast: null, slow: null, signal: 'HOLD' },
    ETH: { fast: null, slow: null, signal: 'HOLD' }
  },
  positions: [],
  closedTrades: [],
  dailyPnL: 0,
  totalPnL: 0,
  circuitBroken: false,
  circuitReason: '',
  logs: [],
  wsConnected: false,
  lastSignalTime: { BTC: 0, ETH: 0 },
  availableContracts: { BTC: [], ETH: [] },
  dashboardClients: []
};

// ─── LOGGING ──────────────────────────────────────────────────────────────────
function log(level, msg, data) {
  const entry = {
    id: Date.now() + Math.random(),
    time: new Date().toISOString(),
    timeIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    level: level,
    msg: msg,
    data: data || null
  };
  state.logs.unshift(entry);
  if (state.logs.length > 500) state.logs = state.logs.slice(0, 500);
  console.log('[' + level + '] ' + entry.timeIST + ' - ' + msg);
  broadcastToDashboard({ type: 'log', entry: entry });
}

// ─── DELTA EXCHANGE API SIGNATURE ─────────────────────────────────────────────
function generateSignature(method, path, queryString, body, timestamp) {
  var signatureData = method + timestamp + path;
  if (queryString) signatureData += '?' + queryString;
  if (body) signatureData += body;
  return crypto.createHmac('sha256', API_SECRET).update(signatureData).digest('hex');
}

function getHeaders(method, endpoint, queryString, body) {
  var timestamp = Math.floor(Date.now() / 1000) + 5;
  var signature = generateSignature(method, endpoint, queryString || '', body || '', timestamp);
  return {
    'api-key': API_KEY,
    'timestamp': timestamp.toString(),
    'signature': signature,
    'Content-Type': 'application/json',
    'User-Agent': 'cryptoedge-ai/1.0'
  };
}

// ─── API CALLS ────────────────────────────────────────────────────────────────
async function apiGet(endpoint, params) {
  try {
    var queryString = params ? Object.keys(params).map(function(k) { return k + '=' + params[k]; }).join('&') : '';
    var headers = getHeaders('GET', endpoint, queryString, '');
    var url = BASE_URL + endpoint + (queryString ? '?' + queryString : '');
    var resp = await axios.get(url, { headers: headers, timeout: 10000 });
    return resp.data;
  } catch (e) {
    log('ERROR', 'GET ' + endpoint + ' failed: ' + (e.response ? JSON.stringify(e.response.data) : e.message));
    return null;
  }
}

async function apiPost(endpoint, body) {
  try {
    var bodyStr = JSON.stringify(body);
    var headers = getHeaders('POST', endpoint, '', bodyStr);
    var url = BASE_URL + endpoint;
    var resp = await axios.post(url, body, { headers: headers, timeout: 10000 });
    return resp.data;
  } catch (e) {
    log('ERROR', 'POST ' + endpoint + ' failed: ' + (e.response ? JSON.stringify(e.response.data) : e.message));
    return null;
  }
}

async function apiDelete(endpoint, body) {
  try {
    var bodyStr = JSON.stringify(body);
    var headers = getHeaders('DELETE', endpoint, '', bodyStr);
    var url = BASE_URL + endpoint;
    var resp = await axios.delete(url, { headers: headers, data: body, timeout: 10000 });
    return resp.data;
  } catch (e) {
    log('ERROR', 'DELETE ' + endpoint + ' failed: ' + (e.response ? JSON.stringify(e.response.data) : e.message));
    return null;
  }
}

// ─── FETCH WALLET BALANCE ──────────────────────────────────────────────────────
async function fetchBalance() {
  var resp = await apiGet('/v2/wallet/balances');
  if (resp && resp.result) {
    var inr = resp.result.find(function(b) { return b.asset_symbol === 'INR'; });
    if (inr) {
      state.capital = parseFloat(inr.available_balance);
      log('INFO', 'Balance updated: INR ' + state.capital.toFixed(2));
      broadcastStatus();
    }
  }
}

// ─── FETCH AVAILABLE OPTIONS CONTRACTS ────────────────────────────────────────
async function fetchContracts() {
  try {
    var resp = await apiGet('/v2/products', { contract_types: 'call_options,put_options', states: 'live' });
    if (resp && resp.result) {
      state.availableContracts.BTC = resp.result.filter(function(p) {
        return p.underlying_asset && p.underlying_asset.symbol === 'BTC';
      });
      state.availableContracts.ETH = resp.result.filter(function(p) {
        return p.underlying_asset && p.underlying_asset.symbol === 'ETH';
      });
      log('INFO', 'Contracts loaded - BTC: ' + state.availableContracts.BTC.length + ', ETH: ' + state.availableContracts.ETH.length);
    }
  } catch (e) {
    log('ERROR', 'fetchContracts failed: ' + e.message);
  }
}

// ─── FIND ATM CONTRACT ─────────────────────────────────────────────────────────
function findATMContract(symbol, optionType, expiry) {
  var contracts = state.availableContracts[symbol];
  if (!contracts || contracts.length === 0) return null;
  var price = state.prices[symbol];
  if (!price) return null;

  var type = optionType === 'CALL' ? 'call_options' : 'put_options';
  var now = new Date();
  var filtered = contracts.filter(function(c) {
    return c.contract_type === type && new Date(c.settlement_time) > now;
  });

  if (expiry === 'weekly') {
    filtered = filtered.filter(function(c) {
      var exp = new Date(c.settlement_time);
      var diff = (exp - now) / (1000 * 60 * 60 * 24);
      return diff <= 8 && diff >= 1;
    });
  } else if (expiry === 'daily') {
    filtered = filtered.filter(function(c) {
      var exp = new Date(c.settlement_time);
      var diff = (exp - now) / (1000 * 60 * 60 * 24);
      return diff <= 1.5;
    });
  }

  if (filtered.length === 0) return null;

  filtered.sort(function(a, b) {
    return Math.abs(parseFloat(a.strike_price) - price) - Math.abs(parseFloat(b.strike_price) - price);
  });

  return filtered[0];
}

// ─── EMA CALCULATION ──────────────────────────────────────────────────────────
function calculateEMA(prices, period) {
  if (prices.length < period) return null;
  var k = 2 / (period + 1);
  var ema = prices.slice(0, period).reduce(function(a, b) { return a + b; }, 0) / period;
  for (var i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function updateEMA(symbol) {
  var candles = state.candles[symbol];
  if (candles.length < state.emaSlow) return;

  var closes = candles.map(function(c) { return c.close; });
  var fast = calculateEMA(closes, state.emaFast);
  var slow = calculateEMA(closes, state.emaSlow);

  var prevFast = state.ema[symbol].fast;
  var prevSlow = state.ema[symbol].slow;
  var prevSignal = state.ema[symbol].signal;

  state.ema[symbol].fast = fast;
  state.ema[symbol].slow = slow;

  var newSignal = 'HOLD';
  if (fast && slow) {
    if (fast > slow) newSignal = 'BULLISH';
    else if (fast < slow) newSignal = 'BEARISH';
  }

  // Crossover detection
  if (prevFast && prevSlow) {
    if (prevFast <= prevSlow && fast > slow) {
      newSignal = 'BUY_CALL';
      log('SIGNAL', symbol + ' EMA CROSSOVER UP - BUY CALL signal generated', { fast: fast.toFixed(2), slow: slow.toFixed(2) });
    } else if (prevFast >= prevSlow && fast < slow) {
      newSignal = 'BUY_PUT';
      log('SIGNAL', symbol + ' EMA CROSSOVER DOWN - BUY PUT signal generated', { fast: fast.toFixed(2), slow: slow.toFixed(2) });
    }
  }

  state.ema[symbol].signal = newSignal;
  broadcastStatus();

  // Act on crossover signals
  if ((newSignal === 'BUY_CALL' || newSignal === 'BUY_PUT') && state.running && !state.paused && !state.circuitBroken) {
    var now = Date.now();
    if (now - state.lastSignalTime[symbol] > 15 * 60 * 1000) {
      state.lastSignalTime[symbol] = now;
      if (isWithinTradingHours()) {
        executeTrade(symbol, newSignal);
      } else {
        log('INFO', 'Signal generated but outside trading hours - skipping');
      }
    }
  }
}

// ─── CANDLE BUILDER ───────────────────────────────────────────────────────────
var candleTimers = {};
var currentCandle = { BTC: null, ETH: null };

function onPriceTick(symbol, price) {
  state.prices[symbol] = price;

  var intervalMs = state.emaFast > 0 ? config.candle_interval_minutes * 60 * 1000 : 15 * 60 * 1000;
  var now = Date.now();
  var bucketTime = Math.floor(now / intervalMs) * intervalMs;

  if (!currentCandle[symbol] || currentCandle[symbol].time !== bucketTime) {
    if (currentCandle[symbol]) {
      state.candles[symbol].push(currentCandle[symbol]);
      if (state.candles[symbol].length > 100) state.candles[symbol].shift();
      updateEMA(symbol);
    }
    currentCandle[symbol] = { time: bucketTime, open: price, high: price, low: price, close: price };
  } else {
    currentCandle[symbol].close = price;
    if (price > currentCandle[symbol].high) currentCandle[symbol].high = price;
    if (price < currentCandle[symbol].low) currentCandle[symbol].low = price;
  }

  checkPositionExits(symbol, price);
  broadcastStatus();
}

// ─── TRADING HOURS CHECK ──────────────────────────────────────────────────────
function isWithinTradingHours() {
  if (!state.tradeActiveHours.enabled) return true;
  var now = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  var nowDate = new Date(now);
  var hours = nowDate.getHours();
  var minutes = nowDate.getMinutes();
  var current = hours * 60 + minutes;

  var parts = state.tradeActiveHours.start.split(':');
  var start = parseInt(parts[0]) * 60 + parseInt(parts[1]);
  var parts2 = state.tradeActiveHours.end.split(':');
  var end = parseInt(parts2[0]) * 60 + parseInt(parts2[1]);

  return current >= start && current <= end;
}

// ─── CIRCUIT BREAKER ──────────────────────────────────────────────────────────
function checkCircuitBreaker() {
  var dailyLossAmount = (state.dailyLossLimit / 100) * state.startingCapital;

  if (state.dailyPnL <= -dailyLossAmount) {
    state.circuitBroken = true;
    state.circuitReason = 'Daily loss limit reached: INR ' + Math.abs(state.dailyPnL).toFixed(2) + ' loss (' + state.dailyLossLimit + '% of capital)';
    state.running = false;
    log('CIRCUIT', 'CIRCUIT BREAKER TRIGGERED - ' + state.circuitReason);
    broadcastStatus();
    return true;
  }
  return false;
}

// ─── EXECUTE TRADE ────────────────────────────────────────────────────────────
async function executeTrade(symbol, signal) {
  if (state.circuitBroken) {
    log('WARN', 'Trade blocked - circuit breaker active');
    return;
  }

  if (state.positions.length >= state.maxOpenPositions) {
    log('WARN', 'Trade blocked - max open positions reached (' + state.maxOpenPositions + ')');
    return;
  }

  var existingPos = state.positions.find(function(p) { return p.symbol === symbol; });
  if (existingPos) {
    log('WARN', 'Trade blocked - already have open position for ' + symbol);
    return;
  }

  var optionType = signal === 'BUY_CALL' ? 'CALL' : 'PUT';
  var contract = findATMContract(symbol, optionType, state.primaryExpiry);

  if (!contract) {
    log('WARN', 'No suitable contract found for ' + symbol + ' ' + optionType);
    return;
  }

  // Position sizing: max 20% of capital per trade
  var maxTradeAmount = (state.maxTradeRiskPct / 100) * state.capital;
  var lotSize = parseFloat(contract.lot_size || 0.001);
  var markPrice = parseFloat(contract.mark_price || 100);
  var tradeAmount = Math.min(maxTradeAmount, state.capital * 0.20);
  var quantity = Math.max(1, Math.floor(tradeAmount / (markPrice * lotSize)));

  log('TRADE', 'Placing ' + optionType + ' order for ' + symbol + ' - Contract: ' + contract.symbol + ' Qty: ' + quantity, {
    contract: contract.symbol,
    strike: contract.strike_price,
    expiry: contract.settlement_time,
    quantity: quantity,
    estimatedCost: (quantity * markPrice * lotSize).toFixed(2)
  });

  var orderBody = {
    product_id: contract.id,
    size: quantity,
    side: 'buy',
    order_type: 'market_order',
    time_in_force: 'ioc'
  };

  var orderResp = await apiPost('/v2/orders', orderBody);

  if (orderResp && orderResp.result) {
    var order = orderResp.result;
    var position = {
      id: order.id || Date.now().toString(),
      symbol: symbol,
      optionType: optionType,
      contractSymbol: contract.symbol,
      strikePrice: contract.strike_price,
      expiry: contract.settlement_time,
      quantity: quantity,
      entryPrice: parseFloat(order.average_fill_price || markPrice),
      currentPrice: parseFloat(order.average_fill_price || markPrice),
      pnl: 0,
      pnlPct: 0,
      openTime: new Date().toISOString(),
      stopLoss: parseFloat(order.average_fill_price || markPrice) * 0.70,
      takeProfit: parseFloat(order.average_fill_price || markPrice) * 1.50,
      lotSize: lotSize,
      orderId: order.id
    };
    state.positions.push(position);
    log('TRADE', 'Position opened: ' + symbol + ' ' + optionType + ' @ ' + position.entryPrice, position);
    broadcastStatus();
  } else {
    log('ERROR', 'Order failed for ' + symbol + ' ' + optionType);
  }
}

// ─── MANUAL TRADE ─────────────────────────────────────────────────────────────
async function manualTrade(symbol, optionType, expiry) {
  if (state.circuitBroken) {
    return { success: false, error: 'Circuit breaker is active. Reset first.' };
  }
  if (state.positions.length >= state.maxOpenPositions) {
    return { success: false, error: 'Max open positions reached.' };
  }
  var signal = optionType === 'CALL' ? 'BUY_CALL' : 'BUY_PUT';
  var prevExpiry = state.primaryExpiry;
  if (expiry) state.primaryExpiry = expiry;
  await executeTrade(symbol, signal);
  state.primaryExpiry = prevExpiry;
  return { success: true };
}

// ─── CLOSE POSITION ───────────────────────────────────────────────────────────
async function closePosition(positionId) {
  var pos = state.positions.find(function(p) { return p.id === positionId; });
  if (!pos) return { success: false, error: 'Position not found' };

  log('TRADE', 'Closing position: ' + pos.symbol + ' ' + pos.optionType + ' @ ' + pos.currentPrice);

  var contract = (state.availableContracts[pos.symbol] || []).find(function(c) { return c.symbol === pos.contractSymbol; });
  if (contract) {
    var closeBody = {
      product_id: contract.id,
      size: pos.quantity,
      side: 'sell',
      order_type: 'market_order',
      time_in_force: 'ioc',
      reduce_only: true
    };
    await apiPost('/v2/orders', closeBody);
  }

  var finalPnL = (pos.currentPrice - pos.entryPrice) * pos.quantity * pos.lotSize;
  state.dailyPnL += finalPnL;
  state.totalPnL += finalPnL;

  var closed = Object.assign({}, pos, {
    closePrice: pos.currentPrice,
    closePnL: finalPnL,
    closeTime: new Date().toISOString()
  });
  state.closedTrades.unshift(closed);
  if (state.closedTrades.length > 100) state.closedTrades = state.closedTrades.slice(0, 100);

  state.positions = state.positions.filter(function(p) { return p.id !== positionId; });

  log('TRADE', 'Position closed. PnL: INR ' + finalPnL.toFixed(2), closed);
  checkCircuitBreaker();
  broadcastStatus();
  return { success: true, pnl: finalPnL };
}

// ─── CLOSE ALL POSITIONS ──────────────────────────────────────────────────────
async function closeAllPositions() {
  log('WARN', 'EMERGENCY CLOSE ALL - closing ' + state.positions.length + ' positions');
  var ids = state.positions.map(function(p) { return p.id; });
  for (var i = 0; i < ids.length; i++) {
    await closePosition(ids[i]);
  }
  return { success: true };
}

// ─── CHECK POSITION EXITS ──────────────────────────────────────────────────────
function checkPositionExits(symbol, price) {
  var toClose = [];
  state.positions.forEach(function(pos) {
    if (pos.symbol !== symbol) return;
    pos.currentPrice = price;
    pos.pnl = (price - pos.entryPrice) * pos.quantity * pos.lotSize;
    pos.pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;

    if (price <= pos.stopLoss) {
      log('TRADE', 'Stop loss hit for ' + pos.symbol + ' ' + pos.optionType + ' - SL: ' + pos.stopLoss.toFixed(2) + ' Price: ' + price.toFixed(2));
      toClose.push(pos.id);
    } else if (price >= pos.takeProfit) {
      log('TRADE', 'Take profit hit for ' + pos.symbol + ' ' + pos.optionType + ' - TP: ' + pos.takeProfit.toFixed(2) + ' Price: ' + price.toFixed(2));
      toClose.push(pos.id);
    }
  });

  toClose.forEach(function(id) { closePosition(id); });
}

// ─── WEBSOCKET TO DELTA EXCHANGE ──────────────────────────────────────────────
var deltaWs = null;
var wsReconnectTimer = null;

function connectDeltaWebSocket() {
  if (deltaWs) {
    try { deltaWs.terminate(); } catch(e) {}
  }

  log('INFO', 'Connecting to Delta Exchange WebSocket...');
  deltaWs = new WebSocket(WS_URL);

  deltaWs.on('open', function() {
    state.wsConnected = true;
    log('INFO', 'Delta Exchange WebSocket connected');

    // Subscribe to BTC and ETH ticker
    var subMsg = JSON.stringify({
      type: 'subscribe',
      payload: {
        channels: [
          { name: 'v2/ticker', symbols: ['BTCUSD', 'ETHUSD'] }
        ]
      }
    });
    deltaWs.send(subMsg);
    broadcastStatus();
  });

  deltaWs.on('message', function(data) {
    try {
      var msg = JSON.parse(data.toString());
      if (msg.type === 'v2/ticker' && msg.symbol) {
        var sym = msg.symbol.replace('USD', '');
        if (sym === 'BTC' || sym === 'ETH') {
          var price = parseFloat(msg.mark_price || msg.close || msg.last_price);
          if (price && price > 0) {
            onPriceTick(sym, price);
          }
        }
      }
    } catch(e) {
      // ignore parse errors
    }
  });

  deltaWs.on('close', function() {
    state.wsConnected = false;
    log('WARN', 'Delta WebSocket disconnected - reconnecting in 5s...');
    broadcastStatus();
    wsReconnectTimer = setTimeout(connectDeltaWebSocket, 5000);
  });

  deltaWs.on('error', function(err) {
    state.wsConnected = false;
    log('ERROR', 'Delta WebSocket error: ' + err.message);
    broadcastStatus();
  });
}

// ─── DASHBOARD WEBSOCKET SERVER ────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', function(ws) {
  state.dashboardClients.push(ws);
  log('INFO', 'Dashboard connected');

  // Send full state immediately
  ws.send(JSON.stringify({ type: 'fullState', data: getPublicState() }));

  ws.on('close', function() {
    state.dashboardClients = state.dashboardClients.filter(function(c) { return c !== ws; });
    log('INFO', 'Dashboard disconnected');
  });

  ws.on('error', function() {
    state.dashboardClients = state.dashboardClients.filter(function(c) { return c !== ws; });
  });
});

function broadcastToDashboard(msg) {
  var str = JSON.stringify(msg);
  state.dashboardClients.forEach(function(ws) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(str); } catch(e) {}
    }
  });
}

function broadcastStatus() {
  broadcastToDashboard({ type: 'status', data: getPublicState() });
}

function getPublicState() {
  return {
    running: state.running,
    paused: state.paused,
    circuitBroken: state.circuitBroken,
    circuitReason: state.circuitReason,
    wsConnected: state.wsConnected,
    capital: state.capital,
    startingCapital: state.startingCapital,
    dailyPnL: state.dailyPnL,
    totalPnL: state.totalPnL,
    dailyLossLimit: state.dailyLossLimit,
    maxTradeRiskPct: state.maxTradeRiskPct,
    emaFast: state.emaFast,
    emaSlow: state.emaSlow,
    instruments: state.instruments,
    primaryExpiry: state.primaryExpiry,
    maxOpenPositions: state.maxOpenPositions,
    tradeActiveHours: state.tradeActiveHours,
    prices: state.prices,
    ema: state.ema,
    positions: state.positions,
    closedTrades: state.closedTrades.slice(0, 20),
    candleCount: { BTC: state.candles.BTC.length, ETH: state.candles.ETH.length },
    serverTime: new Date().toISOString(),
    serverTimeIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  };
}

// ─── REST API ENDPOINTS ───────────────────────────────────────────────────────

// Health check
app.get('/health', function(req, res) {
  res.json({ status: 'ok', version: '1.0.0', name: 'CryptoEdge AI' });
});

// Full state
app.get('/status', function(req, res) {
  res.json(getPublicState());
});

// Logs
app.get('/logs', function(req, res) {
  res.json(state.logs.slice(0, 100));
});

// Start engine
app.post('/control/start', async function(req, res) {
  if (state.circuitBroken) {
    return res.json({ success: false, error: 'Circuit breaker active. Reset first.' });
  }
  state.running = true;
  state.paused = false;
  log('INFO', 'Trading engine STARTED');
  connectDeltaWebSocket();
  await fetchBalance();
  await fetchContracts();
  broadcastStatus();
  res.json({ success: true });
});

// Stop engine
app.post('/control/stop', async function(req, res) {
  state.running = false;
  state.paused = false;
  log('INFO', 'Trading engine STOPPED');
  broadcastStatus();
  res.json({ success: true });
});

// Pause engine
app.post('/control/pause', function(req, res) {
  state.paused = !state.paused;
  log('INFO', 'Trading engine ' + (state.paused ? 'PAUSED' : 'RESUMED'));
  broadcastStatus();
  res.json({ success: true, paused: state.paused });
});

// Reset circuit breaker
app.post('/control/reset-circuit', function(req, res) {
  state.circuitBroken = false;
  state.circuitReason = '';
  state.dailyPnL = 0;
  log('INFO', 'Circuit breaker RESET - daily P&L reset to 0');
  broadcastStatus();
  res.json({ success: true });
});

// Emergency close all
app.post('/control/close-all', async function(req, res) {
  var result = await closeAllPositions();
  state.running = false;
  broadcastStatus();
  res.json(result);
});

// Close specific position
app.post('/position/close', async function(req, res) {
  var id = req.body.id;
  if (!id) return res.json({ success: false, error: 'Position ID required' });
  var result = await closePosition(id);
  res.json(result);
});

// Manual trade
app.post('/trade/manual', async function(req, res) {
  var symbol = req.body.symbol;
  var optionType = req.body.optionType;
  var expiry = req.body.expiry;
  if (!symbol || !optionType) return res.json({ success: false, error: 'symbol and optionType required' });
  var result = await manualTrade(symbol, optionType, expiry);
  res.json(result);
});

// Update settings
app.post('/settings/update', function(req, res) {
  var body = req.body;
  if (body.dailyLossLimit) state.dailyLossLimit = parseFloat(body.dailyLossLimit);
  if (body.maxTradeRiskPct) state.maxTradeRiskPct = parseFloat(body.maxTradeRiskPct);
  if (body.emaFast) state.emaFast = parseInt(body.emaFast);
  if (body.emaSlow) state.emaSlow = parseInt(body.emaSlow);
  if (body.primaryExpiry) state.primaryExpiry = body.primaryExpiry;
  if (body.maxOpenPositions) state.maxOpenPositions = parseInt(body.maxOpenPositions);
  if (body.instruments) state.instruments = body.instruments;
  if (body.tradeActiveHours) state.tradeActiveHours = body.tradeActiveHours;
  log('INFO', 'Settings updated', body);
  broadcastStatus();
  res.json({ success: true });
});

// Daily reset (call this at midnight IST)
app.post('/control/daily-reset', function(req, res) {
  state.dailyPnL = 0;
  state.circuitBroken = false;
  state.circuitReason = '';
  log('INFO', 'Daily reset performed');
  broadcastStatus();
  res.json({ success: true });
});

// ─── AUTO DAILY RESET AT MIDNIGHT IST ─────────────────────────────────────────
function scheduleDailyReset() {
  var now = new Date();
  var ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  var midnight = new Date(ist);
  midnight.setHours(24, 0, 5, 0);
  var msToMidnight = midnight - ist;
  setTimeout(function() {
    state.dailyPnL = 0;
    state.circuitBroken = false;
    state.circuitReason = '';
    log('INFO', 'Auto daily reset at midnight IST');
    broadcastStatus();
    scheduleDailyReset();
  }, msToMidnight);
  log('INFO', 'Daily reset scheduled in ' + Math.round(msToMidnight / 60000) + ' minutes');
}

// ─── CONTRACT REFRESH EVERY 30 MINS ──────────────────────────────────────────
setInterval(function() {
  if (state.running) fetchContracts();
}, 30 * 60 * 1000);

// ─── BALANCE REFRESH EVERY 5 MINS ─────────────────────────────────────────────
setInterval(function() {
  if (state.running) fetchBalance();
}, 5 * 60 * 1000);

// ─── START SERVER ─────────────────────────────────────────────────────────────
var PORT = 3001;
server.listen(PORT, function() {
  log('INFO', 'CryptoEdge AI Server running on port ' + PORT);
  log('INFO', 'Capital: INR ' + state.capital + ' | Daily Loss Limit: ' + state.dailyLossLimit + '%');
  log('INFO', 'Instruments: ' + state.instruments.join(', ') + ' | Primary Expiry: ' + state.primaryExpiry);
  scheduleDailyReset();
});

process.on('uncaughtException', function(err) {
  log('ERROR', 'Uncaught exception: ' + err.message);
});

process.on('unhandledRejection', function(err) {
  log('ERROR', 'Unhandled rejection: ' + (err ? err.message : 'unknown'));
});
