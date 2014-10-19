var blob = require('content-addressable-blob-store');
var wrap = require('level-option-wrap');
var fwdb = require('fwdb');

var defined = require('defined');
var has = require('has');
var isarray = require('isarray');
var stringify = require('json-stable-stringify');

var through = require('through2');
var Readable = require('readable-stream').Readable;
var readonly = require('read-only-stream');
var writeonly = require('write-only-stream');

var inherits = require('inherits');
var EventEmitter = require('events').EventEmitter;

var collect = require('./lib/collect.js');
var dropFirst = require('./lib/drop_first.js');

inherits(ForkDB, EventEmitter);
module.exports = ForkDB;

function ForkDB (db, opts) {
    var self = this;
    if (!(this instanceof ForkDB)) return new ForkDB(db, opts);
    if (!opts) opts = {};
    
    this._fwdb = fwdb(db);
    this.db = this._fwdb.db;
    this.store = defined(
        opts.store,
        blob({ dir: defined(opts.dir, './forkdb.blob') })
    );
    this._queue = [];
    
    this._id = opts.id;
    if (this._id === undefined) {
        this._queue.push(function (cb) {
            self._getId(function (err, id) {
                if (err) return cb(err);
                self._id = id;
                cb(null);
            });
        });
    }
    this._seq = opts.seq;
    if (this._seq === undefined) {
        this._queue.push(function (cb) {
            self._getSeq(function (err, seq) {
                if (err) return cb(err);
                self._seq = seq;
                cb(null);
            });
        });
    }
    this._runQueue();
}

ForkDB.prototype._runQueue = function () {
    var self = this;
    if (self._running) return;
    self._running = true;
    (function next () {
        if (self._queue.length === 0) {
            self._running = false;
            return;
        }
        self._queue.shift()(function (err) {
            if (err) self.emit('error', err)
            else next()
        });
    })();
};

ForkDB.prototype._getId = function (cb) {
    var self = this;
    self.db.get('_id', function (err, value) {
        if (err && err.type === 'NotFoundError') {
            value = generateId();
            self.db.put('_id', value, function (err) {
                if (err) return cb(err)
                cb(null, value);
            });
        }
        else if (err) return cb(err)
        else cb(null, value)
    });
};

ForkDB.prototype._getSeq = function (cb) {
    var self = this;
    self.db.get('_seq', function (err, value) {
        if (err && err.type === 'NotFoundError') cb(null, 0);
        else if (err) cb(err)
        else cb(null, value)
    });
};

ForkDB.prototype.replicate = function (opts, cb) {
    // ...
};

ForkDB.prototype.createWriteStream = function (meta, opts, cb) {
    var self = this;
    var input = through();
    self._queue.push(function (fn) {
        var w = self._createWriteStream(meta, opts, cb);
        w.on('error', fn);
        w.on('complete', function () { fn(null) });
        input.pipe(w);
    });
    self._runQueue();
    return writeonly(input);
};

ForkDB.prototype._createWriteStream = function (meta, opts, cb) {
    var self = this;
    if (typeof meta === 'function') {
        cb = meta;
        opts = {};
        meta = {};
    }
    if (!meta || typeof meta !== 'object') meta = {};
    if (typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
    if (!opts) opts = {};
    var prebatch = defined(
        opts.prebatch,
        function (rows, key, fn) { fn(null, rows) }
    );
    var w = this.store.createWriteStream();
    w.write(stringify(meta) + '\n');
    if (cb) w.on('error', cb);
    
    w.once('finish', function () {
        var prev = getPrev(meta);
        var doc = { hash: w.key, key: meta.key, prev: prev };
        
        var key = defined(meta.key, 'undefined');
        self._fwdb._create(doc, function (err, rows) {
            if (err) return w.emit('error', err);
            if (prev.length === 0) {
                rows.push({
                    type: 'put',
                    key: [ 'tail', meta.key, w.key ],
                    value: 0
                });
            }
            rows.push({ type: 'put', key: [ 'meta', w.key ], value: meta });
            rows.push({ type: 'put', key: '_seq', value: ++ self._seq });
            prebatch(rows, w.key, commit);
        });
    });
    return w;
    
    function commit (err, rows) {
        if (err) return w.emit('error', err);
        if (!isarray(rows)) {
            return w.emit('error', new Error(
                'prebatch result is not an array'
            ));
        }
        self.db.batch(rows, function (err) {
            if (err) return w.emit('error', err);
            if (cb) cb(null, w.key);
            w.emit('complete', w.key);
        });
    }
};

ForkDB.prototype.heads = function (key, opts, cb) {
    return this._fwdb.heads(key, opts, cb);
};

ForkDB.prototype.keys = function (opts, cb) {
    return this._fwdb.keys(opts, cb);
};

ForkDB.prototype.tails = function (key, opts, cb) {
    if (typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
    if (!opts) opts = {};
    var r = this._fwdb.db.createReadStream(wrap(opts, {
        gt: function (x) { return [ 'tail', key, null ] },
        lt: function (x) { return [ 'tail', key, undefined ] }
    }));
    var tr = through.obj(function (row, enc, next) {
        this.push({ hash: row.key[2] });
        next();
    });
    r.on('error', function (err) { tr.emit('error', err) });
    if (cb) tr.pipe(collect(cb));
    if (cb) tr.on('error', cb);
    return readonly(r.pipe(tr));
};

ForkDB.prototype.list = function (opts, cb) {
    if (typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
    if (!opts) opts = {};
    var r = this._fwdb.db.createReadStream(wrap(opts, {
        gt: function (x) { return [ 'meta', defined(x, null) ] },
        lt: function (x) { return [ 'meta', defined(x, undefined) ] }
    }));
    var tr = through.obj(function (row, enc, next) {
        this.push({ meta: row.value, hash: row.key[1] });
        next();
    });
    r.on('error', function (err) { tr.emit('error', err) });
    if (cb) tr.pipe(collect(cb));
    if (cb) tr.on('error', cb);
    return readonly(r.pipe(tr));
};

ForkDB.prototype.createReadStream = function (hash) {
    var r = this.store.createReadStream({ key: hash });
    return readonly(r.pipe(dropFirst()));
};

ForkDB.prototype.get = function (hash, cb) {
    this._fwdb.db.get([ 'meta', hash ], function (err, meta) {
        if (err && cb) cb(err)
        else if (cb) cb(null, meta)
    });
};

ForkDB.prototype.links = function (hash, opts, cb) {
    return this._fwdb.links(hash, opts, cb);
};

ForkDB.prototype.history = function (hash) {
    var self = this;
    var r = new Readable({ objectMode: true });
    var next = hash;
    
    r._read = function () {
        if (!next) return r.push(null);
        self.get(next, onget);
    };
    return r;
    
    function onget (err, meta) {
        if (err) return r.emit('error', err)
        var hash = next;
        var prev = getPrev(meta);
        
        if (prev.length === 0) {
            next = null;
            r.push({ hash: hash, meta: meta });
        }
        else if (prev.length === 1) {
            next = hashOf(prev[0]);
            r.push({ hash: hash, meta: meta });
        }
        else {
            next = null;
            r.push({ hash: hash, meta: meta });
            prev.forEach(function (p) {
                r.emit('branch', self.history(hashOf(p)));
            });
        }
    }
};

ForkDB.prototype.future = function (hash) {
    var self = this;
    var r = new Readable({ objectMode: true });
    var next = hash;
    
    r._read = function () {
        if (!next) return r.push(null);
        
        var pending = 2, ref = {};
        self.get(next, function (err, meta) {
            if (err) return r.emit('error', err);
            ref.meta = meta;
            if (-- pending === 0) done();
        });
        
        self.links(next, function (err, crows) {
            if (err) return r.emit('error', err);
            ref.rows = crows;
            if (-- pending === 0) done();
        });
        
        function done () {
            var prev = next;
            if (ref.rows.length === 0) {
                next = null;
                r.push({ hash: prev, meta: ref.meta });
            }
            else if (ref.rows.length === 1) {
                next = hashOf(ref.rows[0]);
                r.push({ hash: prev, meta: ref.meta });
            }
            else {
                next = null;
                r.push({ hash: prev, meta: ref.meta });
                ref.rows.forEach(function (crow) {
                    r.emit('branch', self.future(hashOf(crow)));
                });
            }
        }
    };
    return r;
};

function getPrev (meta) {
    if (!meta) return [];
    if (!has(meta, 'prev')) return [];
    var prev = meta.prev;
    if (!isarray(prev)) prev = [ prev ];
    return prev.map(function (p) {
        if (p && typeof p === 'object' && p.hash) return p.hash;
        return p;
    }).filter(Boolean);
}

function hashOf (p) {
    return p && typeof p === 'object' ? p.hash : p;
}


function generateId () {
    var s = '';
    for (var i = 0; i < 4; i++) {
        s += Math.floor(Math.random() * Math.pow(16,8)).toString(16);
    }
    return s;
}
