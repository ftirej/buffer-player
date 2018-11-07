'use strict';

const { log } = require('abr-log')('cache');
const { Writable } = require("stream");
const { Analyser } = require("../../adblockradio/post-processing.js");

class AudioCache extends Writable {
	constructor(options) {
		super();
		this.cacheLen = options.cacheLen;
		this.bitrate = 16000; // bytes per second. default value, to be updated later
		this.flushAmount = 60 * this.bitrate;
		this.readCursor = null;
		this.buffer = Buffer.allocUnsafe(this.cacheLen * this.bitrate + 2*this.flushAmount).fill(0);
		this.writeCursor = 0;
	}

	setBitrate(bitrate) {
		if (!isNaN(bitrate) && bitrate > 0 && this.bitrate != bitrate) {
			log.info("AudioCache: bitrate adjusted from " + this.bitrate + "bps to " + bitrate + "bps");

			// if bitrate is higher than expected, expand the buffer accordingly.
			if (bitrate > this.bitrate) {
				var expandBuf = Buffer.allocUnsafe(this.cacheLen * (bitrate - this.bitrate)).fill(0);
				log.info("AudioCache: buffer expanded from " + this.buffer.length + " to " + (this.buffer.length + expandBuf.length) + " bytes");
				this.buffer = Buffer.concat([ this.buffer, expandBuf ]);
			}
			this.bitrate = bitrate;
		}
	}

	_write(data, enc, next) {
		if (this.writeCursor + data.length > this.buffer.length) {
			log.warn("AudioCache: _write: buffer overflow wC=" + this.writeCursor + " dL=" + data.length + " bL=" + this.buffer.length);
		}
		data.copy(this.buffer, this.writeCursor);
		this.writeCursor += data.length;

		//log.debug("AudioCache: _write: add " + data.length + " to buffer, new len=" + this.buffer.length);

		if (this.writeCursor >= this.cacheLen * this.bitrate + this.flushAmount) {
			//log.debug("AudioCache: _write: cutting buffer at len = " + this.cacheLen * this.bitrate);
			this.buffer.copy(this.buffer, 0, this.flushAmount);
			this.writeCursor -= this.flushAmount;

			if (this.readCursor) {
				this.readCursor -= this.flushAmount;
				if (this.readCursor <= 0) this.readCursor = null;
			}
		}
		next();
	}

	readLast(secondsFromEnd, duration) {
		var l = this.writeCursor; //this.buffer.length;
		if (secondsFromEnd < 0 || duration < 0) {
			log.error("AudioCache: readLast: negative secondsFromEnd or duration");
			return null;
		} else if (duration > secondsFromEnd) {
			log.error("AudioCache: readLast: duration=" + duration + " higher than secondsFromEnd=" + secondsFromEnd);
			return null;
		} else if (secondsFromEnd * this.bitrate >= l) {
			log.error("AudioCache: readLast: attempted to read " + secondsFromEnd + " seconds (" + secondsFromEnd * this.bitrate + " b) while bufferLen=" + l);
			return null;
		}
		var data;
		if (duration) {
			data = this.buffer.slice(l - secondsFromEnd * this.bitrate, l - (secondsFromEnd-duration) * this.bitrate);
			this.readCursor = l - (secondsFromEnd-duration) * this.bitrate;
		} else {
			data = this.buffer.slice(l - secondsFromEnd * this.bitrate);
			this.readCursor = l;
		}
		return data;
	}

	readAmountAfterCursor(duration) {
		var nextCursor = this.readCursor + duration * this.bitrate;
		if (duration < 0) {
			log.error("AudioCache: readAmountAfterCursor: negative duration");
			return null;
		} else if (nextCursor >= this.writeCursor) {
			log.warn("AudioCache: readAmountAfterCursor: will read until " + this.writeCursor + " instead of " + nextCursor);
		}
		nextCursor = Math.min(this.writeCursor, nextCursor);
		var data = this.buffer.slice(this.readCursor, nextCursor);
		this.readCursor = nextCursor;
		return data;
	}

	getAvailableCache() {
		return this.buffer ? this.writeCursor / this.bitrate : 0;
	}
}

class MetaCache extends Writable {
	constructor(options) {
		super({ objectMode: true });
		this.meta = {};
		this.cacheLen = options.cacheLen;
	}

	_write(meta, enc, next) {
		if (!meta.type) {
			log.error("MetaCache: no data type");
			return next();
		} else if (!meta.payload) {
			log.warn("MetaCache: empty " + meta.type + " payload");
			return next();
		} else if (meta.validFrom > meta.validTo) {
			log.error("MetaCache: negative time window validFrom=" + meta.validFrom + " validTo=" + meta.validTo);
			return next();
		} else {
			//log.debug("MetaCache: _write: " + JSON.stringify(meta));
		}
		// events of this kind:
		// meta = { type: "metadata", validFrom: Date, validTo: Date, payload: { artist: "...", title : "...", cover: "..." } } ==> metadata for enhanced experience
		// meta = { type: "class", validFrom: Date, validTo: Date, payload: "todo" } ==> class of audio, for automatic channel hopping
		// meta = { type: "volume", validFrom: Date, validTo: Date, payload: [0.85, 0.89, 0.90, ...] } ==> normalized volume for audio player
		// meta = { type: "signal", validFrom: Date, validTo: Date, payload: [0.4, 0.3, ...] } ==> signal amplitude envelope for visualization

		// are stored in the following structure:
		// this.meta = {
		//		"metadata": [
		//			{ validFrom: ..., validTo: ..., payload: { ... } }, (merges the contiguous segments)
		//			...
		//		],
		//		"class": [
		//			{ validFrom: ..., validTo: ..., payload: ... }, (merges the contiguous segments)
		//			...
		//		],
		//		"signal": [
		//			{ validFrom: ..., validTo: ..., payload: [ ... ] },
		//			...
		//		]
		//	}

		switch (meta.type) {
			case "metadata":
			case "class":
			case "volume":
				const curMeta = this.meta[meta.type];
				//log.debug("MetaCache: curMeta=" + JSON.stringify(curMeta));
				if (!curMeta) {
					this.meta[meta.type] = [ { validFrom: meta.validFrom, validTo: meta.validTo, payload: meta.payload } ];
				} else {
					var samePayload = true;

					for (var key in meta.payload) {
						if ("" + meta.payload[key] && "" + meta.payload[key] !== "" + curMeta[curMeta.length-1].payload[key]) {
							samePayload = false;
							//log.debug("MetaCache: _write: different payload key=" + key + " new=" + meta.payload[key] + " vs old=" + this.meta[meta.type][this.meta[meta.type].length-1].payload[key]);
							break;
						}
					}
					if (samePayload) {
						this.meta[meta.type][this.meta[meta.type].length-1].validTo = meta.validTo; // extend current segment validity
					} else {
						this.meta[meta.type][this.meta[meta.type].length-1].validTo = meta.validFrom; // create a new segment
						this.meta[meta.type].push({ validFrom: meta.validFrom, validTo: meta.validTo, payload: meta.payload });
					}
				}
				break;
			case "signal":
				if (!this.meta[meta.type]) {
					this.meta[meta.type] = [ { validFrom: meta.validFrom, validTo: meta.validTo, payload: meta.payload } ];
				} else {
					this.meta[meta.type].push({ validFrom: meta.validFrom, validTo: meta.validTo, payload: meta.payload });
				}
				break;
			default:
				log.error("MetaCache: _write: unknown metadata type = " + meta.type);
		}

		// clean old entries
		while (+this.meta[meta.type][0].validTo <= +new Date() - 1000 * this.cacheLen) {
			this.meta[meta.type].splice(0, 1);
		}

		// fix overlapping entries
		for (var i=0; i<this.meta[meta.type].length-1; i++) {
			if (this.meta[meta.type][i].validTo > this.meta[meta.type][i+1].validFrom) {
				//var middle = (this.meta[meta.type][i].validTo + this.meta[meta.type][i+1].validFrom) / 2;
				var delta = (this.meta[meta.type][i].validTo - this.meta[meta.type][i+1].validFrom) / 2;
				log.debug("MetaCache: fix meta " + meta.type + " overlapping prevTo=" + this.meta[meta.type][i].validTo + " nextFrom=" + this.meta[meta.type][i+1].validFrom + " newBound=" + (this.meta[meta.type][i].validTo - delta));
				this.meta[meta.type][i].validTo -= delta;
				this.meta[meta.type][i+1].validFrom += delta;
			}
		}
		//log.debug("MetaCache: _write: meta[" + meta.type + "]=" + JSON.stringify(this.meta[meta.type]));
		next();
	}

	read(since) {
		if (!since) {
			this.meta.now = +new Date();
			return this.meta;
		} else {
			var result = { now: +new Date() };
			var thrDate = result.now - since*1000;
			typeloop:
			for (var type in this.meta) {
				if (type == "now") continue typeloop;
				if (thrDate < this.meta[type][0].validFrom) {
					result[type] = this.meta[type];
					continue;
				} else {
					itemloop:
					for (var i=0; i<this.meta[type].length; i++) {
						if (this.meta[type][i].validFrom <= thrDate && thrDate < this.meta[type][i].validTo) {
							result[type] = this.meta[type].slice(i);
							break itemloop;
						}
					}
					continue;
				}
				log.warn("MetaCache: read since " + since + "s: no data found for type " + type);
			}
			return result;
		}
	}
}


const startMonitoring = function(country, name, config) {
	const abr = new Analyser({
		country: country,
		name: name,
		config: {
			predInterval: config.user.streamGranularity,
			enablePredictorHotlist: true,
			enablePredictorMl: true,
			saveAudio: false,
			saveMetadata: false,
			fetchMetadata: true,
			verbose: false,
		}
	});

	const audioCache = new AudioCache({ cacheLen: config.user.cacheLen });
	const metaCache = new MetaCache({ cacheLen: config.user.cacheLen });

	abr.on("data", function(obj) {
		//obj.liveResult.audio = "[redacted]";
		obj = obj.liveResult;
		//log.info("status=" + JSON.stringify(Object.assign(obj, { audio: undefined }), null, "\t"));

		audioCache.setBitrate(obj.bitrate);
		if (obj.audio) audioCache.write(obj.audio);
		// todo update bitrate here. set audioCache in Object mode

		const now = +new Date();
		const validFrom = now - 1000 * config.user.streamGranularity / 2;
		const validTo   = now + 1000 * config.user.streamGranularity / 2;
		metaCache.write({
			type: "class",
			validFrom: validFrom,
			validTo: validTo,
			payload: obj.class
		});
		metaCache.write({
			type: "volume",
			validFrom: validFrom,
			validTo: validTo,
			payload: obj.gain
		});
		metaCache.write({
			type: "metadata",
			validFrom: validFrom,
			validTo: validTo,
			payload: obj.metadata
		});
	});

	return {
		predictor: abr,
		audioCache: audioCache,
		metaCache: metaCache,
	}
}

const updateDlList = function(config) {
	log.info("refresh playlist");

	const configList = config.radios.map(r => r.country + "_" + r.name);
	const currentList = config.radios.filter(r => r.liveStatus).map(r =>  r.country + "_" + r.name);

	// add missing monitors
	for (var i=0; i<configList.length; i++) {
		const alreadyThere = currentList.includes(configList[i]);
		if (!alreadyThere) {
			log.info("updateDlList: start " + config.radios[i].country + "_" + config.radios[i].name);
			config.radios[i].liveStatus = startMonitoring(config.radios[i].country, config.radios[i].name, config);
		}
	}

	// remove obsolete ones.
	for (var j=currentList-1; j>=0; j--) {
		const shouldBeThere = configList.includes(currentList[j]);
		if (!shouldBeThere) {
			log.info("updateDlList: stop " + dl[j].country + "_" + dl[j].name);
			const obj = config.radios.filter(r => r.country + "_" + r.name === currentList[j])[0];
			obj.predictor.stopDl();
			delete obj.liveStatus;
		}
	}
}

exports.updateDlList = updateDlList;