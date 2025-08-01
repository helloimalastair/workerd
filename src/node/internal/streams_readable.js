// Copyright (c) 2017-2022 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

/* TODO: the following is adopted code, enabling linting one day */
/* eslint-disable */

import {
  nop,
  getHighWaterMark,
  getDefaultHighWaterMark,
  kPaused,
  addAbortSignal,
  BufferList,
  eos,
  construct,
  destroy,
  destroyer,
  undestroy,
  errorOrDestroy,
  finished,
  kOnConstructed,
} from 'node-internal:streams_util';
import { nextTick } from 'node-internal:internal_process';

import { EventEmitter } from 'node-internal:events';

import { Stream } from 'node-internal:streams_legacy';

import {
  newStreamReadableFromReadableStream,
  newReadableStreamFromStreamReadable,
} from 'node-internal:streams_adapters';

import { Buffer } from 'node-internal:internal_buffer';

import {
  AbortError,
  aggregateTwoErrors,
  ERR_INVALID_ARG_TYPE,
  ERR_METHOD_NOT_IMPLEMENTED,
  ERR_MISSING_ARGS,
  ERR_OUT_OF_RANGE,
  ERR_STREAM_PUSH_AFTER_EOF,
  ERR_STREAM_UNSHIFT_AFTER_END_EVENT,
  ERR_STREAM_NULL_VALUES,
} from 'node-internal:internal_errors';

import {
  validateObject,
  validateAbortSignal,
  validateInteger,
} from 'node-internal:validators';

import { StringDecoder } from 'node-internal:internal_stringdecoder';

import { isDuplexInstance } from 'node-internal:streams_duplex';

// ======================================================================================
// ReadableState

export function ReadableState(options, stream, isDuplex) {
  // Duplex streams are both readable and writable, but share
  // the same options object.
  // However, some cases require setting options to different
  // values for the readable and the writable sides of the duplex stream.
  // These options can be provided separately as readableXXX and writableXXX.
  if (typeof isDuplex !== 'boolean') isDuplex = isDuplexInstance(stream);

  // Object stream flag. Used to make read(n) ignore n and to
  // make all the buffer merging and length checks go away.
  this.objectMode = !!options?.objectMode;
  if (isDuplex)
    this.objectMode = this.objectMode || !!options?.readableObjectMode;

  // The point at which it stops calling _read() to fill the buffer
  // Note: 0 is a valid value, means "don't call _read preemptively ever"
  this.highWaterMark = options
    ? getHighWaterMark(this, options, 'readableHighWaterMark', isDuplex)
    : getDefaultHighWaterMark(false);

  // A linked list is used to store data chunks instead of an array because the
  // linked list can remove elements from the beginning faster than
  // array.shift().
  this.buffer = new BufferList();
  this.length = 0;
  this.pipes = [];
  this.flowing = null;
  this.ended = false;
  this.endEmitted = false;
  this.reading = false;

  // Stream is still being constructed and cannot be
  // destroyed until construction finished or failed.
  // Async construction is opt in, therefore we start as
  // constructed.
  this.constructed = true;

  // A flag to be able to tell if the event 'readable'/'data' is emitted
  // immediately, or on a later tick.  We set this to true at first, because
  // any actions that shouldn't happen until "later" should generally also
  // not happen before the first read call.
  this.sync = true;

  // Whenever we return null, then we set a flag to say
  // that we're awaiting a 'readable' event emission.
  this.needReadable = false;
  this.emittedReadable = false;
  this.readableListening = false;
  this.resumeScheduled = false;
  this[kPaused] = null;

  // True if the error was already emitted and should not be thrown again.
  this.errorEmitted = false;

  // Should close be emitted on destroy. Defaults to true.
  this.emitClose = !options || options.emitClose !== false;

  // Should .destroy() be called after 'end' (and potentially 'finish').
  this.autoDestroy = !options || options.autoDestroy !== false;

  // Has it been destroyed.
  this.destroyed = false;

  // Indicates whether the stream has errored. When true no further
  // _read calls, 'data' or 'readable' events should occur. This is needed
  // since when autoDestroy is disabled we need a way to tell whether the
  // stream has failed.
  this.errored = null;

  // Indicates whether the stream has finished destroying.
  this.closed = false;

  // True if close has been emitted or would have been emitted
  // depending on emitClose.
  this.closeEmitted = false;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options?.defaultEncoding || 'utf8';

  // Ref the piped dest which we need a drain event on it
  // type: null | Writable | Set<Writable>.
  this.awaitDrainWriters = null;
  this.multiAwaitDrain = false;

  // If true, a maybeReadMore has been scheduled.
  this.readingMore = false;
  this.dataEmitted = false;
  this.decoder = null;
  this.encoding = null;
  if (options && options.encoding) {
    this.decoder = new StringDecoder(options.encoding);
    this.encoding = options.encoding;
  }
}

ReadableState.prototype[kOnConstructed] = function onConstructed(stream) {
  if (this.needReadable) {
    maybeReadMore(stream, this);
  }
};

// ======================================================================================
// Readable

Readable.ReadableState = ReadableState;

Object.setPrototypeOf(Readable.prototype, Stream.prototype);
Object.setPrototypeOf(Readable, Stream);

export function Readable(options) {
  if (!(this instanceof Readable)) return new Readable(options);

  // Checking for a Stream.Duplex instance is faster here instead of inside
  // the ReadableState constructor, at least with V8 6.5.
  const isDuplex = isDuplexInstance(this);
  this._readableState = new ReadableState(options, this, isDuplex);
  if (options) {
    if (typeof options.read === 'function') this._read = options.read;
    if (typeof options.destroy === 'function') this._destroy = options.destroy;
    if (typeof options.construct === 'function')
      this._construct = options.construct;
    if (options.signal && !isDuplex) addAbortSignal(options.signal, this);
  }
  Stream.call(this, options);
  construct(this, () => {
    if (this._readableState.needReadable) {
      maybeReadMore(this, this._readableState);
    }
  });
}
Readable.prototype.destroy = destroy;
Readable.prototype._undestroy = undestroy;
Readable.prototype._destroy = function (err, cb) {
  if (cb) cb(err);
};

Readable.prototype[EventEmitter.captureRejectionSymbol] = function (err) {
  this.destroy(err);
};

// Manually shove something into the read() buffer.
// This returns true if the highWaterMark has not been hit yet,
// similar to how Writable.write() returns true if you should
// write() some more.
Readable.prototype.push = function (chunk, encoding) {
  return readableAddChunk(this, chunk, encoding, false);
};

// Unshift should *always* be something directly out of read().
Readable.prototype.unshift = function (chunk, encoding) {
  return readableAddChunk(this, chunk, encoding, true);
};

function readableAddChunk(stream, chunk, encoding, addToFront) {
  const state = stream._readableState;
  let err;
  if (!state.objectMode) {
    if (typeof chunk === 'string') {
      encoding ||= state.defaultEncoding;
      if (state.encoding !== encoding) {
        if (addToFront && state.encoding) {
          // When unshifting, if state.encoding is set, we have to save
          // the string in the BufferList with the state encoding.
          chunk = Buffer.from(chunk, encoding).toString(state.encoding);
        } else {
          chunk = Buffer.from(chunk, encoding);
          encoding = '';
        }
      }
    } else if (chunk instanceof Buffer) {
      encoding = '';
    } else if (Stream._isUint8Array(chunk)) {
      chunk = Stream._uint8ArrayToBuffer(chunk);
      encoding = '';
    } else if (chunk != null) {
      err = new ERR_INVALID_ARG_TYPE(
        'chunk',
        ['string', 'Buffer', 'Uint8Array'],
        chunk
      );
    }
  }
  if (err) {
    errorOrDestroy(stream, err);
  } else if (chunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
  } else if (state.objectMode || (chunk && chunk.length > 0)) {
    if (addToFront) {
      if (state.endEmitted)
        errorOrDestroy(stream, new ERR_STREAM_UNSHIFT_AFTER_END_EVENT());
      else if (state.destroyed || state.errored) return false;
      else addChunk(stream, state, chunk, true);
    } else if (state.ended) {
      errorOrDestroy(stream, new ERR_STREAM_PUSH_AFTER_EOF());
    } else if (state.destroyed || state.errored) {
      return false;
    } else {
      state.reading = false;
      if (state.decoder && !encoding) {
        chunk = state.decoder.write(chunk);
        if (state.objectMode || chunk.length !== 0)
          addChunk(stream, state, chunk, false);
        else maybeReadMore(stream, state);
      } else {
        addChunk(stream, state, chunk, false);
      }
    }
  } else if (!addToFront) {
    state.reading = false;
    maybeReadMore(stream, state);
  }

  // We can push more data if we are below the highWaterMark.
  // Also, if we have no data yet, we can stand some more bytes.
  // This is to work around cases where hwm=0, such as the repl.
  return (
    !state.ended && (state.length < state.highWaterMark || state.length === 0)
  );
}

function addChunk(stream, state, chunk, addToFront) {
  if (
    state.flowing &&
    state.length === 0 &&
    !state.sync &&
    stream.listenerCount('data') > 0
  ) {
    // Use the guard to avoid creating `Set()` repeatedly
    // when we have multiple pipes.
    if (state.multiAwaitDrain) {
      state.awaitDrainWriters.clear();
    } else {
      state.awaitDrainWriters = null;
      state.multiAwaitDrain = false;
    }
    state.dataEmitted = true;
    stream.emit('data', chunk);
  } else {
    // Update the buffer info.
    state.length += state.objectMode ? 1 : chunk.length;
    if (addToFront) state.buffer.unshift(chunk);
    else state.buffer.push(chunk);
    if (state.needReadable) emitReadable(stream);
  }
  maybeReadMore(stream, state);
}

Readable.prototype.isPaused = function () {
  const state = this._readableState;
  return state[kPaused] === true || state.flowing === false;
};

// Backwards compatibility.
Readable.prototype.setEncoding = function (enc) {
  const decoder = new StringDecoder(enc);
  this._readableState.decoder = decoder;
  // If setEncoding(null), decoder.encoding equals utf8.
  this._readableState.encoding = decoder.encoding;
  const buffer = this._readableState.buffer;
  // Iterate over current buffer to convert already stored Buffers:
  let content = '';
  for (const data of buffer) {
    content += decoder.write(data);
  }
  buffer.clear();
  if (content !== '') buffer.push(content);
  this._readableState.length = content.length;
  return this;
};

// Don't raise the hwm > 1GB.
const MAX_HWM = 0x40000000;
function computeNewHighWaterMark(n) {
  if (n > MAX_HWM) {
    throw new ERR_OUT_OF_RANGE('size', '<= 1GiB', n);
  } else {
    // Get the next highest power of 2 to prevent increasing hwm excessively in
    // tiny amounts.
    n--;
    n |= n >>> 1;
    n |= n >>> 2;
    n |= n >>> 4;
    n |= n >>> 8;
    n |= n >>> 16;
    n++;
  }
  return n;
}

// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function howMuchToRead(n, state) {
  if (n <= 0 || (state.length === 0 && state.ended)) return 0;
  if (state.objectMode) return 1;
  if (Number.isNaN(n)) {
    // Only flow one buffer at a time.
    if (state.flowing && state.length) return state.buffer.first().length;
    return state.length;
  }
  if (n <= state.length) return n;
  return state.ended ? state.length : 0;
}

// You can override either this method, or the async _read(n) below.
Readable.prototype.read = function (n) {
  // Same as parseInt(undefined, 10), however V8 7.3 performance regressed
  // in this scenario, so we are doing it manually.
  if (n === undefined) {
    n = NaN;
  } else if (!Number.isInteger(n)) {
    n = Number.parseInt(`${n}`, 10);
  }
  const state = this._readableState;
  const nOrig = n;

  // If we're asking for more than the current hwm, then raise the hwm.
  if (n > state.highWaterMark) state.highWaterMark = computeNewHighWaterMark(n);
  if (n !== 0) state.emittedReadable = false;

  // If we're doing read(0) to trigger a readable event, but we
  // already have a bunch of data in the buffer, then just trigger
  // the 'readable' event and move on.
  if (
    n === 0 &&
    state.needReadable &&
    ((state.highWaterMark !== 0
      ? state.length >= state.highWaterMark
      : state.length > 0) ||
      state.ended)
  ) {
    if (state.length === 0 && state.ended) endReadable(this);
    else emitReadable(this);
    return null;
  }
  n = howMuchToRead(n, state);

  // If we've ended, and we're now clear, then finish it up.
  if (n === 0 && state.ended) {
    if (state.length === 0) endReadable(this);
    return null;
  }

  // All the actual chunk generation logic needs to be
  // *below* the call to _read.  The reason is that in certain
  // synthetic stream cases, such as passthrough streams, _read
  // may be a completely synchronous operation which may change
  // the state of the read buffer, providing enough data when
  // before there was *not* enough.
  //
  // So, the steps are:
  // 1. Figure out what the state of things will be after we do
  // a read from the buffer.
  //
  // 2. If that resulting state will trigger a _read, then call _read.
  // Note that this may be asynchronous, or synchronous.  Yes, it is
  // deeply ugly to write APIs this way, but that still doesn't mean
  // that the Readable class should behave improperly, as streams are
  // designed to be sync/async agnostic.
  // Take note if the _read call is sync or async (ie, if the read call
  // has returned yet), so that we know whether or not it's safe to emit
  // 'readable' etc.
  //
  // 3. Actually pull the requested chunks out of the buffer and return.

  // if we need a readable event, then we need to do some reading.
  let doRead = state.needReadable;

  // If we currently have less than the highWaterMark, then also read some.
  if (state.length === 0 || state.length - n < state.highWaterMark) {
    doRead = true;
  }

  // However, if we've ended, then there's no point, if we're already
  // reading, then it's unnecessary, if we're constructing we have to wait,
  // and if we're destroyed or errored, then it's not allowed,
  if (
    state.ended ||
    state.reading ||
    state.destroyed ||
    state.errored ||
    !state.constructed
  ) {
    doRead = false;
  } else if (doRead) {
    state.reading = true;
    state.sync = true;
    // If the length is currently zero, then we *need* a readable event.
    if (state.length === 0) state.needReadable = true;

    // Call internal read method
    try {
      this._read(state.highWaterMark);
    } catch (err) {
      errorOrDestroy(this, err);
    }
    state.sync = false;
    // If _read pushed data synchronously, then `reading` will be false,
    // and we need to re-evaluate how much data we can return to the user.
    if (!state.reading) n = howMuchToRead(nOrig, state);
  }
  let ret;
  if (n > 0) ret = fromList(n, state);
  else ret = null;
  if (ret === null) {
    state.needReadable = state.length <= state.highWaterMark;
    n = 0;
  } else {
    state.length -= n;
    if (state.multiAwaitDrain) {
      state.awaitDrainWriters.clear();
    } else {
      state.awaitDrainWriters = null;
      state.multiAwaitDrain = false;
    }
  }
  if (state.length === 0) {
    // If we have nothing in the buffer, then we want to know
    // as soon as we *do* get something into the buffer.
    if (!state.ended) state.needReadable = true;

    // If we tried to read() past the EOF, then emit end on the next tick.
    if (nOrig !== n && state.ended) endReadable(this);
  }
  if (ret !== null && !state.errorEmitted && !state.closeEmitted) {
    state.dataEmitted = true;
    this.emit('data', ret);
  }
  return ret;
};

function onEofChunk(stream, state) {
  if (state.ended) return;
  if (state.decoder) {
    const chunk = state.decoder.end();
    if (chunk && chunk.length) {
      state.buffer.push(chunk);
      state.length += state.objectMode ? 1 : chunk.length;
    }
  }
  state.ended = true;
  if (state.sync) {
    // If we are sync, wait until next tick to emit the data.
    // Otherwise we risk emitting data in the flow()
    // the readable code triggers during a read() call.
    emitReadable(stream);
  } else {
    // Emit 'readable' now to make sure it gets picked up.
    state.needReadable = false;
    state.emittedReadable = true;
    // We have to emit readable now that we are EOF. Modules
    // in the ecosystem (e.g. dicer) rely on this event being sync.
    emitReadable_(stream);
  }
}

// Don't emit readable right away in sync mode, because this can trigger
// another read() call => stack overflow.  This way, it might trigger
// a nextTick recursion warning, but that's not so bad.
function emitReadable(stream) {
  const state = stream._readableState;
  state.needReadable = false;
  if (!state.emittedReadable) {
    state.emittedReadable = true;
    nextTick(emitReadable_, stream);
  }
}

function emitReadable_(stream) {
  const state = stream._readableState;
  if (!state.destroyed && !state.errored && (state.length || state.ended)) {
    stream.emit('readable');
    state.emittedReadable = false;
  }

  // The stream needs another readable event if:
  // 1. It is not flowing, as the flow mechanism will take
  //    care of it.
  // 2. It is not ended.
  // 3. It is below the highWaterMark, so we can schedule
  //    another readable later.
  state.needReadable =
    !state.flowing && !state.ended && state.length <= state.highWaterMark;
  flow(stream);
}

// At this point, the user has presumably seen the 'readable' event,
// and called read() to consume some data.  that may have triggered
// in turn another _read(n) call, in which case reading = true if
// it's in progress.
// However, if we're not ended, or reading, and the length < hwm,
// then go ahead and try to read some more preemptively.
function maybeReadMore(stream, state) {
  if (!state.readingMore && state.constructed) {
    state.readingMore = true;
    nextTick(maybeReadMore_, stream, state);
  }
}

function maybeReadMore_(stream, state) {
  // Attempt to read more data if we should.
  //
  // The conditions for reading more data are (one of):
  // - Not enough data buffered (state.length < state.highWaterMark). The loop
  //   is responsible for filling the buffer with enough data if such data
  //   is available. If highWaterMark is 0 and we are not in the flowing mode
  //   we should _not_ attempt to buffer any extra data. We'll get more data
  //   when the stream consumer calls read() instead.
  // - No data in the buffer, and the stream is in flowing mode. In this mode
  //   the loop below is responsible for ensuring read() is called. Failing to
  //   call read here would abort the flow and there's no other mechanism for
  //   continuing the flow if the stream consumer has just subscribed to the
  //   'data' event.
  //
  // In addition to the above conditions to keep reading data, the following
  // conditions prevent the data from being read:
  // - The stream has ended (state.ended).
  // - There is already a pending 'read' operation (state.reading). This is a
  //   case where the stream has called the implementation defined _read()
  //   method, but they are processing the call asynchronously and have _not_
  //   called push() with new data. In this case we skip performing more
  //   read()s. The execution ends in this method again after the _read() ends
  //   up calling push() with more data.
  while (
    !state.reading &&
    !state.ended &&
    (state.length < state.highWaterMark ||
      (state.flowing && state.length === 0))
  ) {
    const len = state.length;
    stream.read(0);
    if (len === state.length)
      // Didn't get any data, stop spinning.
      break;
  }
  state.readingMore = false;
}

// Abstract method.  to be overridden in specific implementation classes.
// call cb(er, data) where data is <= n in length.
// for virtual (non-string, non-buffer) streams, "length" is somewhat
// arbitrary, and perhaps not very meaningful.
Readable.prototype._read = function (_size) {
  throw new ERR_METHOD_NOT_IMPLEMENTED('_read()');
};

Readable.prototype.pipe = function (dest, pipeOpts) {
  const src = this;
  const state = this._readableState;
  if (state.pipes.length === 1) {
    if (!state.multiAwaitDrain) {
      state.multiAwaitDrain = true;
      state.awaitDrainWriters = new Set(
        state.awaitDrainWriters ? [state.awaitDrainWriters] : []
      );
    }
  }
  state.pipes.push(dest);
  const doEnd = !pipeOpts || pipeOpts.end !== false;
  const endFn = doEnd ? onend : unpipe;
  if (state.endEmitted) nextTick(endFn);
  else src.once('end', endFn);
  dest.on('unpipe', onunpipe);
  function onunpipe(readable, unpipeInfo) {
    if (readable === src) {
      if (unpipeInfo && unpipeInfo.hasUnpiped === false) {
        unpipeInfo.hasUnpiped = true;
        cleanup();
      }
    }
  }
  function onend() {
    dest.end();
  }
  let ondrain;
  let cleanedUp = false;
  function cleanup() {
    // Cleanup event handlers once the pipe is broken.
    dest.removeListener('close', onclose);
    dest.removeListener('finish', onfinish);
    if (ondrain) {
      dest.removeListener('drain', ondrain);
    }
    dest.removeListener('error', onerror);
    dest.removeListener('unpipe', onunpipe);
    src.removeListener('end', onend);
    src.removeListener('end', unpipe);
    src.removeListener('data', ondata);
    cleanedUp = true;

    // If the reader is waiting for a drain event from this
    // specific writer, then it would cause it to never start
    // flowing again.
    // So, if this is awaiting a drain, then we just call it now.
    // If we don't know, then assume that we are waiting for one.
    if (
      ondrain &&
      state.awaitDrainWriters &&
      (!dest._writableState || dest._writableState.needDrain)
    )
      ondrain();
  }
  function pause() {
    // If the user unpiped during `dest.write()`, it is possible
    // to get stuck in a permanently paused state if that write
    // also returned false.
    // => Check whether `dest` is still a piping destination.
    if (!cleanedUp) {
      if (state.pipes.length === 1 && state.pipes[0] === dest) {
        state.awaitDrainWriters = dest;
        state.multiAwaitDrain = false;
      } else if (state.pipes.length > 1 && state.pipes.includes(dest)) {
        state.awaitDrainWriters.add(dest);
      }
      src.pause();
    }
    if (!ondrain) {
      // When the dest drains, it reduces the awaitDrain counter
      // on the source.  This would be more elegant with a .once()
      // handler in flow(), but adding and removing repeatedly is
      // too slow.
      ondrain = pipeOnDrain(src, dest);
      dest.on('drain', ondrain);
    }
  }
  src.on('data', ondata);
  function ondata(chunk) {
    const ret = dest.write(chunk);
    if (ret === false) {
      pause();
    }
  }

  // If the dest has an error, then stop piping into it.
  // However, don't suppress the throwing behavior for this.
  function onerror(er) {
    unpipe();
    dest.removeListener('error', onerror);
    if (dest.listenerCount('error') === 0) {
      const s = dest._writableState || dest._readableState;
      if (s && !s.errorEmitted) {
        // User incorrectly emitted 'error' directly on the stream.
        errorOrDestroy(dest, er);
      } else {
        dest.emit('error', er);
      }
    }
  }

  // Make sure our error handler is attached before userland ones.
  dest.prependListener('error', onerror);

  // Both close and finish should trigger unpipe, but only once.
  function onclose() {
    dest.removeListener('finish', onfinish);
    unpipe();
  }
  dest.once('close', onclose);
  function onfinish() {
    dest.removeListener('close', onclose);
    unpipe();
  }
  dest.once('finish', onfinish);
  function unpipe() {
    src.unpipe(dest);
  }

  // Tell the dest that it's being piped to.
  dest.emit('pipe', src);

  // Start the flow if it hasn't been started already.

  if (dest.writableNeedDrain === true) {
    if (state.flowing) {
      pause();
    }
  } else if (!state.flowing) {
    src.resume();
  }
  return dest;
};

function pipeOnDrain(src, dest) {
  return function pipeOnDrainFunctionResult() {
    const state = src._readableState;

    // `ondrain` will call directly,
    // `this` maybe not a reference to dest,
    // so we use the real dest here.
    if (state.awaitDrainWriters === dest) {
      state.awaitDrainWriters = null;
    } else if (state.multiAwaitDrain) {
      state.awaitDrainWriters.delete(dest);
    }
    if (
      (!state.awaitDrainWriters || state.awaitDrainWriters.size === 0) &&
      src.listenerCount('data')
    ) {
      src.resume();
    }
  };
}

Readable.prototype.unpipe = function (dest) {
  const state = this._readableState;
  const unpipeInfo = {
    hasUnpiped: false,
  };

  // If we're not piping anywhere, then do nothing.
  if (state.pipes.length === 0) return this;
  if (!dest) {
    // remove all.
    const dests = state.pipes;
    state.pipes = [];
    this.pause();
    for (let i = 0; i < dests.length; i++)
      dests[i].emit('unpipe', this, {
        hasUnpiped: false,
      });
    return this;
  }

  // Try to find the right one.
  const index = state.pipes.indexOf(dest);
  if (index === -1) return this;
  state.pipes.splice(index, 1);
  if (state.pipes.length === 0) this.pause();
  dest.emit('unpipe', this, unpipeInfo);
  return this;
};

// Set up data events if they are asked for
// Ensure readable listeners eventually get something.
Readable.prototype.on = function (ev, fn) {
  const res = Stream.prototype.on.call(this, ev, fn);
  const state = this._readableState;
  if (ev === 'data') {
    // Update readableListening so that resume() may be a no-op
    // a few lines down. This is needed to support once('readable').
    state.readableListening = this.listenerCount('readable') > 0;

    // Try start flowing on next tick if stream isn't explicitly paused.
    if (state.flowing !== false) this.resume();
  } else if (ev === 'readable') {
    if (!state.endEmitted && !state.readableListening) {
      state.readableListening = state.needReadable = true;
      state.flowing = false;
      state.emittedReadable = false;
      if (state.length) {
        emitReadable(this);
      } else if (!state.reading) {
        nextTick(nReadingNextTick, this);
      }
    }
  }
  return res;
};
Readable.prototype.addListener = Readable.prototype.on;
Readable.prototype.removeListener = function (ev, fn) {
  const res = Stream.prototype.removeListener.call(this, ev, fn);
  if (ev === 'readable') {
    // We need to check if there is someone still listening to
    // readable and reset the state. However this needs to happen
    // after readable has been emitted but before I/O (nextTick) to
    // support once('readable', fn) cycles. This means that calling
    // resume within the same tick will have no
    // effect.
    nextTick(updateReadableListening, this);
  }
  return res;
};
Readable.prototype.off = Readable.prototype.removeListener;
Readable.prototype.removeAllListeners = function (ev) {
  const res = Stream.prototype.removeAllListeners.apply(this, arguments);
  if (ev === 'readable' || ev === undefined) {
    // We need to check if there is someone still listening to
    // readable and reset the state. However this needs to happen
    // after readable has been emitted but before I/O (nextTick) to
    // support once('readable', fn) cycles. This means that calling
    // resume within the same tick will have no
    // effect.
    nextTick(updateReadableListening, this);
  }
  return res;
};

function updateReadableListening(self) {
  const state = self._readableState;
  state.readableListening = self.listenerCount('readable') > 0;
  if (state.resumeScheduled && state[kPaused] === false) {
    // Flowing needs to be set to true now, otherwise
    // the upcoming resume will not flow.
    state.flowing = true;

    // Crude way to check if we should resume.
  } else if (self.listenerCount('data') > 0) {
    self.resume();
  } else if (!state.readableListening) {
    state.flowing = null;
  }
}

function nReadingNextTick(self) {
  self.read(0);
}

// pause() and resume() are remnants of the legacy readable stream API
// If the user uses them, then switch into old mode.
Readable.prototype.resume = function () {
  const state = this._readableState;
  if (!state.flowing) {
    // We flow only if there is no one listening
    // for readable, but we still have to call
    // resume().
    state.flowing = !state.readableListening;
    resume(this, state);
  }
  state[kPaused] = false;
  return this;
};

function resume(stream, state) {
  if (!state.resumeScheduled) {
    state.resumeScheduled = true;
    nextTick(resume_, stream, state);
  }
}

function resume_(stream, state) {
  if (!state.reading) {
    stream.read(0);
  }
  state.resumeScheduled = false;
  stream.emit('resume');
  flow(stream);
  if (state.flowing && !state.reading) stream.read(0);
}

Readable.prototype.pause = function () {
  if (this._readableState.flowing !== false) {
    this._readableState.flowing = false;
    this.emit('pause');
  }
  this._readableState[kPaused] = true;
  return this;
};

function flow(stream) {
  const state = stream._readableState;
  while (state.flowing && stream.read() !== null);
}

// Wrap an old-style stream as the async data source.
// This is *not* part of the readable stream interface.
// It is an ugly unfortunate mess of history.
Readable.prototype.wrap = function (stream) {
  let paused = false;

  // TODO (ronag): Should this.destroy(err) emit
  // 'error' on the wrapped stream? Would require
  // a static factory method, e.g. Readable.wrap(stream).
  stream.on('data', (chunk) => {
    if (!this.push(chunk) && stream.pause) {
      paused = true;
      stream.pause();
    }
  });

  stream.on('end', () => {
    this.push(null);
  });
  stream.on('error', (err) => {
    errorOrDestroy(this, err);
  });
  stream.on('close', () => {
    this.destroy();
  });
  stream.on('destroy', () => {
    this.destroy();
  });
  this._read = () => {
    if (paused && stream.resume) {
      paused = false;
      stream.resume();
    }
  };

  // Proxy all the other methods. Important when wrapping filters and duplexes.
  const streamKeys = Object.keys(stream);
  for (let j = 1; j < streamKeys.length; j++) {
    const i = streamKeys[j];
    if (this[i] === undefined && typeof stream[i] === 'function') {
      this[i] = stream[i].bind(stream);
    }
  }
  return this;
};

Readable.prototype[Symbol.asyncIterator] = function () {
  return streamToAsyncIterator(this);
};

Readable.prototype.iterator = function (options) {
  if (options !== undefined) {
    validateObject(options, 'options', options);
  }
  return streamToAsyncIterator(this, options);
};

function streamToAsyncIterator(stream, options) {
  if (typeof stream.read !== 'function') {
    stream = Readable.wrap(stream, {
      objectMode: true,
    });
  }
  const iter = createAsyncIterator(stream, options);
  iter.stream = stream;
  return iter;
}

async function* createAsyncIterator(stream, options) {
  let callback = nop;
  function next(resolve) {
    if (this === stream) {
      callback();
      callback = nop;
    } else {
      callback = resolve;
    }
  }
  stream.on('readable', next);
  let error;
  const cleanup = eos(
    stream,
    {
      writable: false,
    },
    (err) => {
      error = err ? aggregateTwoErrors(error, err) : null;
      callback();
      callback = nop;
    }
  );
  try {
    while (true) {
      const chunk = stream.destroyed ? null : stream.read();
      if (chunk !== null) {
        yield chunk;
      } else if (error) {
        throw error;
      } else if (error === null) {
        return;
      } else {
        await new Promise(next);
      }
    }
  } catch (err) {
    error = aggregateTwoErrors(error, err);
    throw error;
  } finally {
    if (
      (error ||
        (options === null || options === undefined
          ? undefined
          : options.destroyOnReturn) !== false) &&
      (error === undefined || stream._readableState.autoDestroy)
    ) {
      destroyer(stream, null);
    } else {
      stream.off('readable', next);
      cleanup();
    }
  }
}

// Making it explicit these properties are not enumerable
// because otherwise some prototype manipulation in
// userland will fail.
Object.defineProperties(Readable.prototype, {
  readable: {
    get() {
      const r = this._readableState;
      // r.readable === false means that this is part of a Duplex stream
      // where the readable side was disabled upon construction.
      // Compat. The user might manually disable readable side through
      // deprecated setter.
      return (
        !!r &&
        r.readable !== false &&
        !r.destroyed &&
        !r.errorEmitted &&
        !r.endEmitted
      );
    },
    set(val) {
      // Backwards compat.
      if (this._readableState) {
        this._readableState.readable = !!val;
      }
    },
  },
  readableDidRead: {
    enumerable: false,
    get: function () {
      return !!this._readableState?.dataEmitted;
    },
  },
  readableAborted: {
    enumerable: false,
    get: function () {
      return !!(
        this._readableState?.readable !== false &&
        (this._readableState?.destroyed || this._readableState?.errored) &&
        !this._readableState?.endEmitted
      );
    },
  },
  readableHighWaterMark: {
    enumerable: false,
    get: function () {
      return this._readableState?.highWaterMark;
    },
  },
  readableBuffer: {
    enumerable: false,
    get: function () {
      return this._readableState?.buffer;
    },
  },
  readableFlowing: {
    enumerable: false,
    get: function () {
      return !!this._readableState?.flowing;
    },
    set: function (state) {
      if (this._readableState) {
        this._readableState.flowing = state;
      }
    },
  },
  readableLength: {
    enumerable: false,
    get() {
      return this._readableState?.length | 0;
    },
  },
  readableObjectMode: {
    enumerable: false,
    get() {
      return this._readableState ? this._readableState.objectMode : false;
    },
  },
  readableEncoding: {
    enumerable: false,
    get() {
      return this._readableState?.encoding || null;
    },
  },
  errored: {
    enumerable: false,
    get() {
      return this._readableState?.errored || null;
    },
  },
  closed: {
    get() {
      return !!this._readableState?.closed;
    },
  },
  destroyed: {
    enumerable: false,
    get() {
      return !!this._readableState?.destroyed;
    },
    set(value) {
      // We ignore the value if the stream
      // has not been initialized yet.
      if (!this._readableState) {
        return;
      }

      // Backward compatibility, the user is explicitly
      // managing destroyed.
      this._readableState.destroyed = value;
    },
  },
  readableEnded: {
    enumerable: false,
    get() {
      return !!this._readableState?.endEmitted;
    },
  },
});

Object.defineProperties(ReadableState.prototype, {
  // Legacy getter for `pipesCount`.
  pipesCount: {
    get() {
      return this.pipes.length;
    },
  },
  // Legacy property for `paused`.
  paused: {
    get() {
      return this[kPaused] !== false;
    },
    set(value) {
      this[kPaused] = !!value;
    },
  },
});

// Exposed for testing purposes only.
Readable._fromList = fromList;

// Pluck off n bytes from an array of buffers.
// Length is the combined lengths of all the buffers in the list.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function fromList(n, state) {
  // nothing buffered.
  if (state.length === 0) return null;
  let ret;
  if (state.objectMode) ret = state.buffer.shift();
  else if (!n || n >= state.length) {
    // Read it all, truncate the list.
    if (state.decoder) ret = state.buffer.join('');
    else if (state.buffer.length === 1) ret = state.buffer.first();
    else ret = state.buffer.concat(state.length);
    state.buffer.clear();
  } else {
    // read part of list.
    ret = state.buffer.consume(n, !!state.decoder);
  }
  return ret;
}

function endReadable(stream) {
  const state = stream._readableState;
  if (!state.endEmitted) {
    state.ended = true;
    nextTick(endReadableNT, state, stream);
  }
}

function endReadableNT(state, stream) {
  // Check that we didn't get one last unshift.
  if (
    !state.errored &&
    !state.closeEmitted &&
    !state.endEmitted &&
    state.length === 0
  ) {
    state.endEmitted = true;
    stream.emit('end');
    if (stream.writable && stream.allowHalfOpen === false) {
      nextTick(endWritableNT, stream);
    } else if (state.autoDestroy) {
      // In case of duplex streams we need a way to detect
      // if the writable side is ready for autoDestroy as well.
      const wState = stream._writableState;
      const autoDestroy =
        !wState ||
        (wState.autoDestroy &&
          // We don't expect the writable to ever 'finish'
          // if writable is explicitly set to false.
          (wState.finished || wState.writable === false));
      if (autoDestroy) {
        stream.destroy();
      }
    }
  }
}

function endWritableNT(stream) {
  const writable =
    stream.writable && !stream.writableEnded && !stream.destroyed;
  if (writable) {
    stream.end();
  }
}

export function fromWeb(readableStream, options) {
  return newStreamReadableFromReadableStream(readableStream, options);
}

export function toWeb(streamReadable, options) {
  return newReadableStreamFromStreamReadable(streamReadable, options);
}

export function wrap(src, options) {
  let _ref, _src$readableObjectMo;
  return new Readable({
    objectMode:
      (_ref =
        (_src$readableObjectMo = src.readableObjectMode) !== null &&
        _src$readableObjectMo !== undefined
          ? _src$readableObjectMo
          : src.objectMode) !== null && _ref !== undefined
        ? _ref
        : true,
    ...options,
    destroy(err, callback) {
      destroyer(src, err);
      callback(err);
    },
  }).wrap(src);
}

Readable.toWeb = toWeb;
Readable.fromWeb = fromWeb;
Readable.wrap = wrap;

// ======================================================================================
//

Readable.from = function (iterable, opts) {
  return from(Readable, iterable, opts);
};

export function from(Readable, iterable, opts) {
  let iterator;
  if (typeof iterable === 'string' || iterable instanceof Buffer) {
    return new Readable({
      objectMode: true,
      ...opts,
      read() {
        this.push(iterable);
        this.push(null);
      },
    });
  }
  let isAsync;
  if (iterable && iterable[Symbol.asyncIterator]) {
    isAsync = true;
    iterator = iterable[Symbol.asyncIterator]();
  } else if (iterable && iterable[Symbol.iterator]) {
    isAsync = false;
    iterator = iterable[Symbol.iterator]();
  } else {
    throw new ERR_INVALID_ARG_TYPE('iterable', ['Iterable'], iterable);
  }
  const readable = new Readable({
    objectMode: true,
    highWaterMark: 1,
    // TODO(ronag): What options should be allowed?
    ...opts,
  });

  // Flag to protect against _read
  // being called before last iteration completion.
  let reading = false;
  readable._read = function () {
    if (!reading) {
      reading = true;
      next();
    }
  };
  readable._destroy = function (error, cb) {
    close(error).then(
      () => nextTick(cb, error),
      (err) => nextTick(cb, err || error)
    );
  };
  async function close(error) {
    const hadError = error !== undefined && error !== null;
    const hasThrow = typeof iterator.throw === 'function';
    if (hadError && hasThrow) {
      const { value, done } = await iterator.throw(error);
      await value;
      if (done) {
        return;
      }
    }
    if (typeof iterator.return === 'function') {
      const { value } = await iterator.return();
      await value;
    }
  }
  async function next() {
    for (;;) {
      try {
        const { value, done } = isAsync
          ? await iterator.next()
          : iterator.next();
        if (done) {
          readable.push(null);
        } else {
          const res =
            value && typeof value.then === 'function' ? await value : value;
          if (res === null) {
            reading = false;
            throw new ERR_STREAM_NULL_VALUES();
          } else if (readable.push(res)) {
            continue;
          } else {
            reading = false;
          }
        }
      } catch (err) {
        readable.destroy(err);
      }
      break;
    }
  }
  return readable;
}

// ======================================================================================
// Operators

const kWeakHandler = Symbol('kWeak');
const kEmpty = Symbol('kEmpty');
const kEof = Symbol('kEof');

function map(fn, options) {
  if (typeof fn !== 'function') {
    throw new ERR_INVALID_ARG_TYPE('fn', ['Function', 'AsyncFunction'], fn);
  }
  if (options != null) {
    validateObject(options, 'options', options);
  }
  if (options?.signal != null) {
    validateAbortSignal(options.signal, 'options.signal');
  }
  let concurrency = 1;
  if (options?.concurrency != null) {
    concurrency = Math.floor(options.concurrency);
  }
  validateInteger(concurrency, 'concurrency', 1);
  return async function* map() {
    let _options$signal, _options$signal2;
    const ac = new AbortController();
    const stream = this;
    const queue = [];
    const signal = ac.signal;
    const signalOpt = {
      signal,
    };
    const abort = () => ac.abort();
    if (
      options !== null &&
      options !== undefined &&
      (_options$signal = options.signal) !== null &&
      _options$signal !== undefined &&
      _options$signal.aborted
    ) {
      abort();
    }
    options === null || options === undefined
      ? undefined
      : (_options$signal2 = options.signal) === null ||
          _options$signal2 === undefined
        ? undefined
        : _options$signal2.addEventListener('abort', abort);
    let next;
    let resume;
    let done = false;
    function onDone() {
      done = true;
    }
    async function pump() {
      try {
        for await (let val of stream) {
          let _val;
          if (done) {
            return;
          }
          if (signal.aborted) {
            throw new AbortError();
          }
          try {
            val = fn(val, signalOpt);
          } catch (err) {
            val = Promise.reject(err);
          }
          if (val === kEmpty) {
            continue;
          }
          if (
            typeof ((_val = val) === null || _val === undefined
              ? undefined
              : _val.catch) === 'function'
          ) {
            val.catch(onDone);
          }
          queue.push(val);
          if (next) {
            next();
            next = null;
          }
          if (!done && queue.length && queue.length >= concurrency) {
            await new Promise((resolve) => {
              resume = resolve;
            });
          }
        }
        queue.push(kEof);
      } catch (err) {
        const val = Promise.reject(err);
        val.then(undefined, onDone);
        queue.push(val);
      } finally {
        let _options$signal3;
        done = true;
        if (next) {
          next();
          next = null;
        }
        options === null || options === undefined
          ? undefined
          : (_options$signal3 = options.signal) === null ||
              _options$signal3 === undefined
            ? undefined
            : _options$signal3.removeEventListener('abort', abort);
      }
    }
    pump();
    try {
      while (true) {
        while (queue.length > 0) {
          const val = await queue[0];
          if (val === kEof) {
            return;
          }
          if (signal.aborted) {
            throw new AbortError();
          }
          if (val !== kEmpty) {
            yield val;
          }
          queue.shift();
          if (resume) {
            resume();
            resume = null;
          }
        }
        await new Promise((resolve) => {
          next = resolve;
        });
      }
    } finally {
      ac.abort();
      done = true;
      if (resume) {
        resume();
        resume = null;
      }
    }
  }.call(this);
}

function asIndexedPairs(options) {
  if (options != null) {
    validateObject(options, 'options', options);
  }
  if (
    (options === null || options === undefined ? undefined : options.signal) !=
    null
  ) {
    validateAbortSignal(options.signal, 'options.signal');
  }
  return async function* asIndexedPairs() {
    let index = 0;
    for await (const val of this) {
      let _options$signal4;
      if (
        options !== null &&
        options !== undefined &&
        (_options$signal4 = options.signal) !== null &&
        _options$signal4 !== undefined &&
        _options$signal4.aborted
      ) {
        throw new AbortError('Aborted', {
          cause: options.signal?.reason,
        });
      }
      yield [index++, val];
    }
  }.call(this);
}

async function some(fn, options) {
  if (typeof fn !== 'function') {
    throw new ERR_INVALID_ARG_TYPE('fn', ['Function', 'AsyncFunction'], fn);
  }
  for await (const _ of filter.call(this, fn, options)) {
    return true;
  }
  return false;
}

async function every(fn, options) {
  if (typeof fn !== 'function') {
    throw new ERR_INVALID_ARG_TYPE('fn', ['Function', 'AsyncFunction'], fn);
  }
  // https://en.wikipedia.org/wiki/De_Morgan%27s_laws
  return !(await some.call(
    this,
    async (...args) => {
      return !(await fn(...args));
    },
    options
  ));
}

async function find(fn, options) {
  for await (const result of filter.call(this, fn, options)) {
    return result;
  }
  return undefined;
}

async function forEach(fn, options) {
  if (typeof fn !== 'function') {
    throw new ERR_INVALID_ARG_TYPE('fn', ['Function', 'AsyncFunction'], fn);
  }
  async function forEachFn(value, options) {
    await fn(value, options);
    return kEmpty;
  }
  // eslint-disable-next-line no-unused-vars
  for await (const _ of map.call(this, forEachFn, options));
}

function filter(fn, options) {
  if (typeof fn !== 'function') {
    throw new ERR_INVALID_ARG_TYPE('fn', ['Function', 'AsyncFunction'], fn);
  }
  async function filterFn(value, options) {
    if (await fn(value, options)) {
      return value;
    }
    return kEmpty;
  }
  return map.call(this, filterFn, options);
}

// Specific to provide better error to reduce since the argument is only
// missing if the stream has no items in it - but the code is still appropriate
class ReduceAwareErrMissingArgs extends ERR_MISSING_ARGS {
  constructor() {
    super('reduce');
    this.message = 'Reduce of an empty stream requires an initial value';
  }
}

async function reduce(reducer, initialValue, options) {
  let _options$signal5;
  if (typeof reducer !== 'function') {
    throw new ERR_INVALID_ARG_TYPE(
      'reducer',
      ['Function', 'AsyncFunction'],
      reducer
    );
  }
  if (options != null) {
    validateObject(options, 'options', options);
  }
  if (options?.signal != null) {
    validateAbortSignal(options?.signal, 'options.signal');
  }
  let hasInitialValue = arguments.length > 1;
  if (
    options !== null &&
    options !== undefined &&
    (_options$signal5 = options.signal) !== null &&
    _options$signal5 !== undefined &&
    _options$signal5.aborted
  ) {
    const err = new AbortError(undefined, {
      cause: options.signal?.reason,
    });
    this.once('error', () => {}); // The error is already propagated
    await finished(this.destroy(err));
    throw err;
  }
  const ac = new AbortController();
  const signal = ac.signal;
  if (options?.signal) {
    const opts = {
      once: true,
      [kWeakHandler]: this,
    };
    options.signal.addEventListener('abort', () => ac.abort(), opts);
  }
  let gotAnyItemFromStream = false;
  try {
    for await (const value of this) {
      let _options$signal6;
      gotAnyItemFromStream = true;
      if (
        options !== null &&
        options !== undefined &&
        (_options$signal6 = options.signal) !== null &&
        _options$signal6 !== undefined &&
        _options$signal6.aborted
      ) {
        throw new AbortError();
      }
      if (!hasInitialValue) {
        initialValue = value;
        hasInitialValue = true;
      } else {
        initialValue = await reducer(initialValue, value, {
          signal,
        });
      }
    }
    if (!gotAnyItemFromStream && !hasInitialValue) {
      throw new ReduceAwareErrMissingArgs();
    }
  } finally {
    ac.abort();
  }
  return initialValue;
}

async function toArray(options) {
  if (options != null) {
    validateObject(options, 'options', options);
  }
  if (options?.signal != null) {
    validateAbortSignal(options?.signal, 'options.signal');
  }
  const result = [];
  for await (const val of this) {
    let _options$signal7;
    if (
      options !== null &&
      options !== undefined &&
      (_options$signal7 = options.signal) !== null &&
      _options$signal7 !== undefined &&
      _options$signal7.aborted
    ) {
      throw new AbortError(undefined, {
        cause: options.signal?.reason,
      });
    }
    result.push(val);
  }
  return result;
}

function flatMap(fn, options) {
  const values = map.call(this, fn, options);
  return async function* flatMap() {
    for await (const val of values) {
      yield* val;
    }
  }.call(this);
}

function toIntegerOrInfinity(number) {
  // We coerce here to align with the spec
  // https://github.com/tc39/proposal-iterator-helpers/issues/169
  number = Number(number);
  if (Number.isNaN(number)) {
    return 0;
  }
  if (number < 0) {
    throw new ERR_OUT_OF_RANGE('number', '>= 0', number);
  }
  return number;
}

function drop(number, options) {
  if (options != null) {
    validateObject(options, 'options', options);
  }
  if (options?.signal != null) {
    validateAbortSignal(options?.signal, 'options.signal');
  }
  number = toIntegerOrInfinity(number);
  return async function* drop() {
    let _options$signal8;
    if (
      options !== null &&
      options !== undefined &&
      (_options$signal8 = options.signal) !== null &&
      _options$signal8 !== undefined &&
      _options$signal8.aborted
    ) {
      throw new AbortError();
    }
    for await (const val of this) {
      let _options$signal9;
      if (
        options !== null &&
        options !== undefined &&
        (_options$signal9 = options.signal) !== null &&
        _options$signal9 !== undefined &&
        _options$signal9.aborted
      ) {
        throw new AbortError();
      }
      if (number-- <= 0) {
        yield val;
      }
    }
  }.call(this);
}

function take(number, options) {
  if (options != null) {
    validateObject(options, 'options', options);
  }
  if (options?.signal != null) {
    validateAbortSignal(options?.signal, 'options.signal');
  }
  number = toIntegerOrInfinity(number);
  return async function* take() {
    let _options$signal10;
    if (
      options !== null &&
      options !== undefined &&
      (_options$signal10 = options.signal) !== null &&
      _options$signal10 !== undefined &&
      _options$signal10.aborted
    ) {
      throw new AbortError();
    }
    for await (const val of this) {
      let _options$signal11;
      if (
        options !== null &&
        options !== undefined &&
        (_options$signal11 = options.signal) !== null &&
        _options$signal11 !== undefined &&
        _options$signal11.aborted
      ) {
        throw new AbortError();
      }
      if (number-- > 0) {
        yield val;
      } else {
        return;
      }
    }
  }.call(this);
}

Readable.prototype.map = function (fn, options) {
  return from(Readable, map.call(this, fn, options));
};

Readable.prototype.asIndexedPairs = function (options) {
  return from(Readable, asIndexedPairs.call(this, options));
};

Readable.prototype.drop = function (number, options) {
  return from(Readable, drop.call(this, number, options));
};

Readable.prototype.filter = function (fn, options) {
  return from(Readable, filter.call(this, fn, options));
};

Readable.prototype.flatMap = function (fn, options) {
  return from(Readable, flatMap.call(this, fn, options));
};

Readable.prototype.take = function (number, options) {
  return from(Readable, take.call(this, number, options));
};

Readable.prototype.every = every;
Readable.prototype.forEach = forEach;
Readable.prototype.reduce = reduce;
Readable.prototype.toArray = toArray;
Readable.prototype.some = some;
Readable.prototype.find = find;
