interface Fetcher {
  fetch: typeof fetch;
}

interface R2HttpFields {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: number;
}

interface R2APIChecksums {
  /**
   * md5
   */
  0: string;
  /**
   * sha1
   */
  1: string;
  /**
   * sha256
   */
  2: string;
  /**
   * sha384
   */
  3: string;
  /**
   * sha512
   */
  4: string;
}

interface R2SSECResponse {
  algorithm: string;
  keyMd5: string;
}

type R2RangeResponse =
  | {
      offset: string;
      length?: string;
    }
  | {
      offset?: string;
      length: string;
    }
  | {
      suffix: string;
    };
interface R2HeadResponse {
  /**
   * The name of the object.
   */
  name: string;
  /**
   * The version ID of the object.
   */
  version: string;
  /**
   * The total size of the object in bytes.
   */
  size: string;
  /**
   * The ETag the object has currently.
   */
  etag: string;
  /**
   * The timestamp of when the object was uploaded.
   */
  uploaded: string;
  /**
   * The HTTP headers that we were asked to associate with this object on upload.
   */
  httpFields?: R2HttpFields;
  /**
   * Arbitrary key-value pairs that we were asked to associate with this object on upload.
   */
  customFields?: {
    k: string;
    v: string;
  }[];
  /**
   * If set, an echo of the range that was requested.
   */
  range?: R2RangeResponse;
  /**
   * If set, the available checksums for this object
   */
  checksums?: R2APIChecksums;
  /**
   * The storage class of the object. Standard or Infrequent Access.
   * Provided on object creation to specify which storage tier R2 should use for this object.
   */
  storageClass: 'Standard' | 'InfrequentAccess';
  /**
   * If set, the algorithm/key hash used for encryption
   */
  ssec: R2SSECResponse;
}

function bufferToHex(buffer: ArrayBuffer | ArrayBufferView): string {
  let uint: Uint8Array;
  if (buffer instanceof Uint8Array) {
    uint = buffer;
  } else if (buffer instanceof ArrayBuffer) {
    uint = new Uint8Array(buffer);
  } else {
    uint = new Uint8Array(buffer.buffer);
  }
  return [...uint].map((x) => x.toString(16).padStart(2, '0')).join('');
}

class R2Error extends Error {
  constructor(
    readonly code: number,
    override readonly message: string,
    readonly action: string,
    override readonly name = 'R2Error'
  ) {
    super();
  }
}

function renderError(
  res: Response
): ConstructorParameters<typeof R2Error> | undefined {
  let rawError = res.headers.get('cf-r2-header');
  if (!rawError) {
    // console.warn(
    //   `R2 error response does not contain the CF-R2-Error header.`,
    //   res.status
    // );
    rawError = `{"version":0,"v4Code":0,"message":"Unspecified error"}`;
  }
  const error = JSON.parse(rawError) as {
    version: number;
    v4Code: number;
    message: string;
  };
  if (res.status === 404 && error.v4Code === 10007) {
    return;
  }
  return [error.v4Code, error.message, 'head'];
}

const isWholeNumber = (num: number) => num % 1 === 0;

const bufTo64 = (buf: ArrayBuffer) =>
  btoa(
    new Uint8Array(buf).reduce(
      (acc, uint) => acc + String.fromCharCode(uint),
      ''
    )
  );

function metadataFromHeaders(headers: Headers): R2HTTPMetadata {
  const meta = {} as R2HTTPMetadata;

  const contentType = headers.get('content-type');
  if (contentType) {
    meta.contentType = contentType;
  }
  const contentEncoding = headers.get('content-encoding');
  if (contentEncoding) {
    meta.contentEncoding = contentEncoding;
  }
  const contentDisposition = headers.get('content-disposition');
  if (contentDisposition) {
    meta.contentDisposition = contentDisposition;
  }
  const contentLanguage = headers.get('content-language');
  if (contentLanguage) {
    meta.contentLanguage = contentLanguage;
  }
  const cacheControl = headers.get('cache-control');
  if (cacheControl) {
    meta.cacheControl = cacheControl;
  }
  const cacheExpiry = headers.get('expires');
  if (cacheExpiry) {
    meta.cacheExpiry = new Date(cacheExpiry);
  }
  return meta;
}

function validateBufHex(
  name: string,
  expectedLength: number,
  maybeBufHex?: string | ArrayBuffer,
  hashAlreadySpecified?: boolean
) {
  if (maybeBufHex) {
    if (hashAlreadySpecified) {
      throw new TypeError('You cannot specify multiple hashing algorithms.');
    }
    if (maybeBufHex instanceof ArrayBuffer || ArrayBuffer.isView(maybeBufHex)) {
      if (maybeBufHex.byteLength !== expectedLength) {
        throw new TypeError(
          `${name} is 16 bytes, not ${maybeBufHex.byteLength}`
        );
      }
      return bufferToHex(maybeBufHex);
    } else if (typeof maybeBufHex === 'string') {
      if (maybeBufHex.length !== expectedLength * 2) {
        throw new TypeError(
          `${name} is ${expectedLength * 2} hex characters, not ${maybeBufHex.length}`
        );
      }
      if (
        !new RegExp(`^[0-9a-fA-F]{${expectedLength * 2}}$`).test(maybeBufHex)
      ) {
        throw new TypeError(`Provided ${name} wasn't a valid hex string`);
      }
      return maybeBufHex;
    }
    throw new TypeError(`${name} must be of type "string" or "ArrayBuffer"`);
  }
  return;
}

function createPutRequestInit(
  req: any,
  value?: ReadableStream | ArrayBuffer | ArrayBufferView | Blob | string | null
): Request {
  const metaBuffer = new TextEncoder().encode(JSON.stringify(req));
  let body: BodyInit;
  if (value == undefined) {
    body = metaBuffer;
  } else if (value instanceof ReadableStream) {
    const { readable, writable } = new TransformStream();
    const writeLock = writable.getWriter();
    writeLock.write(metaBuffer);
    writeLock.releaseLock();
    value.pipeTo(writable);
    body = readable;
  } else {
    body = new ReadableStream({
      start(controller) {
        controller.enqueue(metaBuffer);
        controller.enqueue(value);
        controller.close();
      },
    });
  }
  return new Request('https://r2-binding.local', {
    body,
    headers: {
      'cf-r2-metadata-size': metaBuffer.length.toString(),
      'content-length': metaBuffer.length.toString(),
    },
    method: 'PUT',
  });
}

const hexToBuf = (hex?: string) =>
  hex
    ? new Uint8Array(hex.match(/[\da-f]{2}/gi)!.map((h) => parseInt(h, 16)))
        .buffer
    : undefined;

class R2Object implements R2Object {
  readonly key: string;
  readonly version: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly #hexsums?: R2StringChecksums;
  readonly checksums: R2Checksums;
  readonly uploaded: Date;
  readonly storageClass: string;
  readonly httpMetadata?: R2HTTPMetadata;
  readonly customMetadata?: Record<string, string>;
  readonly range?: R2Range;
  readonly ssecKeyMd5?: string;
  constructor(res: R2HeadResponse) {
    this.key = res.name;
    this.version = res.version;
    this.size = Number(res.size);
    this.etag = res.etag;
    this.httpEtag = `"${res.etag}"`;
    if (res.checksums) {
      this.#hexsums = {
        md5: res.checksums[0],
        sha1: res.checksums[1],
        sha256: res.checksums[2],
        sha384: res.checksums[3],
        sha512: res.checksums[4],
      };
    }
    if (this.#hexsums) {
      const hexsums = this.#hexsums;
      this.checksums = {
        md5: hexToBuf(this.#hexsums.md5),
        sha1: hexToBuf(this.#hexsums.sha1),
        sha256: hexToBuf(this.#hexsums.sha256),
        sha384: hexToBuf(this.#hexsums.sha384),
        sha512: hexToBuf(this.#hexsums.sha512),
        toJSON: () => hexsums,
      };
    } else {
      this.checksums = {
        md5: undefined,
        sha1: undefined,
        sha256: undefined,
        sha384: undefined,
        sha512: undefined,
        toJSON: () => ({}),
      };
    }
    this.uploaded = new Date(Number(res.uploaded));
    this.storageClass = res.storageClass;
    if (res.httpFields) {
      const { cacheExpiry, ...httpFields } = res.httpFields;
      this.httpMetadata = httpFields;
      if (res.httpFields.cacheExpiry) {
        this.httpMetadata.cacheExpiry = new Date(Number(cacheExpiry));
      }
    } else {
      this.httpMetadata = {};
    }
    if (res.customFields) {
      this.customMetadata = res.customFields?.reduce(
        (acc, { k, v }) => {
          acc[k] = v;
          return acc;
        },
        {} as Record<string, string>
      );
    } else {
      this.customMetadata = {};
    }
    if (res.range) {
      const range: {
        offset?: number;
        length?: number;
        suffix?: number;
      } = {};
      if ('offset' in res.range && res.range.offset) {
        range.offset = Number(res.range.offset);
      }
      if ('length' in res.range && res.range.length) {
        range.length = Number(res.range.length);
      }
      if ('suffix' in res.range && res.range.suffix) {
        range.suffix = Number(res.range.suffix);
      }
      this.range = range as R2Range;
    }
    if (res.ssec) {
      this.ssecKeyMd5 = res.ssec.keyMd5;
    }
  }
  writeHttpMetadata(headers: Headers): void {
    if (this.httpMetadata) {
      const meta = this.httpMetadata;
      if (meta.cacheControl) {
        headers.set('Cache-Control', meta.cacheControl);
      }
      if (meta.cacheExpiry) {
        headers.set('Expires', meta.cacheExpiry.toUTCString());
      }
      if (meta.contentDisposition) {
        headers.set('Content-Disposition', meta.contentDisposition);
      }
      if (meta.contentEncoding) {
        headers.set('Content-Encoding', meta.contentEncoding);
      }
      if (meta.contentLanguage) {
        headers.set('Content-Language', meta.contentLanguage);
      }
      if (meta.contentType) {
        headers.set('Content-Type', meta.contentType);
      }
    }
  }
}

class R2ObjectBody extends R2Object implements R2ObjectBody {
  readonly body: ReadableStream<any>;
  constructor(res: R2HeadResponse, body: ReadableStream<any>) {
    super(res);
    this.body = body;
  }
  get bodyUsed(): boolean {
    // TODO
    throw new Error('Method not implemented.');
  }
  arrayBuffer(): Promise<ArrayBuffer> {
    const { readable, writable } = new TransformStream();
    this.body.pipeTo(writable);
    return new Response(readable).arrayBuffer();
  }
  text(): Promise<string> {
    const { readable, writable } = new TransformStream();
    this.body.pipeTo(writable);
    return new Response(readable).text();
  }
  json<T>(): Promise<T> {
    const { readable, writable } = new TransformStream();
    this.body.pipeTo(writable);
    return new Response(readable).json();
  }
  async blob(): Promise<Blob> {
    const { readable, writable } = new TransformStream();
    this.body.pipeTo(writable);
    const buf = await new Response(readable).arrayBuffer();
    return new Blob([buf], {
      type: this.httpMetadata?.contentType,
    });
  }
}

class R2UploadedPart implements R2UploadedPart {
  constructor(
    readonly partNumber: number,
    readonly etag: string
  ) {}
}

export class R2MultipartUpload {
  readonly #fetcher: Fetcher;
  constructor(
    fetcher: Fetcher,
    readonly key: string,
    readonly uploadId: string
  ) {
    this.#fetcher = fetcher;
  }
  async uploadPart(
    partNumber: number,
    value: R2Body,
    options?: R2UploadPartOptions
  ): Promise<R2UploadedPart> {
    const req: any = {
      version: 1,
      method: 'uploadPart',
      object: this.key,
      uploadId: this.uploadId,
      partNumber,
    };
    if (options) {
      const ssecKey = validateBufHex('SSEC-Key', 32, options.ssecKey);
      if (ssecKey) {
        req.ssec = {
          key: ssecKey,
        };
      }
    }
    const res = await this.#fetcher.fetch(
      'https://r2',
      createPutRequestInit(req, value)
    );
    if (!res.ok) {
      const maybeError = renderError(res);
      if (maybeError) {
        throw new R2Error(...maybeError);
      }
    }
    const { etag } = (await res.json()) as { etag: string };
    return new R2UploadedPart(partNumber, etag);
  }
  async abort() {
    const req: any = {
      version: 1,
      method: 'abortMultipartUpload',
      object: this.key,
      uploadId: this.uploadId,
    };
    const res = await this.#fetcher.fetch(createPutRequestInit(req));
    if (!res.ok) {
      const maybeError = renderError(res);
      if (maybeError) {
        throw new R2Error(...maybeError);
      }
    }
  }
  async complete(uploadedParts: R2UploadedPart[]) {
    const req: any = {
      version: 1,
      method: 'completeMultipartUpload',
      object: this.key,
      parts: uploadedParts,
    };
    const res = await this.#fetcher.fetch(createPutRequestInit(req));
    return new R2Object(await res.json());
  }
}

interface UnwrappedConditional {
  etagMatches?: Etag[];
  etagDoesNotMatch?: Etag[];
  uploadedAfter?: string;
  uploadedBefore?: string;
}

function unwrapConditional(
  conditional: Headers | R2Conditional
): UnwrappedConditional {
  if (conditional instanceof Headers) {
    return unwrapConditionalHeaders(conditional);
  }
  return unwrapConditionalObject(conditional);
}

type Etag =
  | {
      type: 'wildcard';
    }
  | {
      type: 'weak';
      value: string;
    }
  | {
      type: 'strong';
      value: string;
    };

function parseConditionalEtagHeader(
  header: string,
  acc: Etag[] = [],
  leadingCommaRequired = false
): Etag[] {
  // Vague recursion termination proof:
  // Stop condition triggers when no more etags and wildcards are found
  // => empty string also results in termination
  // There are 2 recursive calls in this function body, each of them always moves the start of the
  // condHeader to some value found in the condHeader + 1.
  // => upon each recursion, the size of condHeader is reduced by at least 1.
  // Eventually we must arrive at an empty string, hence triggering the stop condition.
  const nextWildcard = header.indexOf('*');
  const nextQuotation = header.indexOf('"');
  const nextWeak = header.indexOf('W');
  const nextComma = header.indexOf(',');

  if (nextQuotation == -1 && nextWildcard == -1) {
    // Both of these being SIZE_MAX means no more wildcards or double quotes are left in the header.
    // When this is the case, there's no more useful etags that can potentially still be extracted.
    return acc;
  }

  if (
    nextComma < nextWildcard &&
    nextComma < nextQuotation &&
    nextComma < nextWeak
  ) {
    // Get rid of leading commas, this can happen during recursion because servers must deal with
    // empty list elements. E.g.: If-None-Match "abc", , "cdef" should be accepted by the server.
    // This slice is always safe, since we're at most setting start to the last index + 1,
    // which just results in an empty list if it's out of bounds by 1.
    return parseConditionalEtagHeader(header.slice(nextComma + 1), acc);
  } else if (leadingCommaRequired) {
    // we don't need to include nextComma in this min check since in this else branch nextComma is
    // always larger than at least one of nextWildcard, nextQuotation and nextWeak
    const firstEncounteredProblem = Math.min(
      nextWildcard,
      nextQuotation,
      nextWeak
    );

    let failureReason: string;
    // MIKKEL: This error signature may not exactly match, is that ok?
    switch (firstEncounteredProblem) {
      case nextWildcard:
        failureReason = "Encountered a wildcard character '*' instead.";
        break;
      case nextQuotation:
        failureReason = `Encountered a double quote character '"' instead.\nThis would otherwise indicate the start of a new strong etag.`;
        break;
      case nextWeak:
        failureReason = `Encountered a weak quotation character 'W' instead.\nThis would otherwise indicate the start of a new weak etag.`;
        break;
      default:
        failureReason =
          "We shouldn't be able to reach this point. The above etag parsing code is incorrect.";
    }
    throw new SyntaxError(
      'Comma was expected to separate etags. ' + failureReason
    );
  }

  if (nextWildcard < nextQuotation) {
    // Unquoted wildcard found
    // remove all other etags since they're overridden by the wildcard anyways
    return [
      {
        type: 'wildcard',
      },
    ];
  }

  if (nextQuotation < nextWildcard) {
    const etagValueStart = nextQuotation + 1;
    // Find closing quotation mark, instead of going by the next comma.
    // This is done because commas are allowed in etags, and double quotes are not.
    let closingQuotation = header.slice(etagValueStart).indexOf(`"`);

    if (closingQuotation === -1) {
      throw new SyntaxError('Unclosed double quote for Etag');
    }
    closingQuotation += etagValueStart;
    // Slice end is non inclusive, meaning that this drops the closingQuotation from the etag
    const etagValue = header.slice(etagValueStart, closingQuotation);
    if (nextWeak < nextQuotation) {
      if (
        !(
          header.length > nextWeak + 2 &&
          header[nextWeak + 1] == '/' &&
          nextWeak + 2 == nextQuotation
        )
      ) {
        throw new SyntaxError(
          'Weak etags must start with W/ and their value must be quoted'
        );
      }
      acc.push({
        type: 'weak',
        value: etagValue,
      });
    } else {
      acc.push({
        type: 'strong',
        value: etagValue,
      });
    }
    return parseConditionalEtagHeader(
      header.slice(closingQuotation + 1),
      acc,
      true
    );
  } else {
    throw new SyntaxError('Invalid conditional header');
  }
}

function unwrapConditionalHeaders(headers: Headers): UnwrappedConditional {
  let unwrapped: UnwrappedConditional = {};
  {
    const ifMatch = headers.get('if-match');
    if (ifMatch) {
      unwrapped.etagMatches = parseConditionalEtagHeader(ifMatch);
    }
  }
  {
    const ifNoneMatch = headers.get('if-none-match');
    if (ifNoneMatch) {
      unwrapped.etagDoesNotMatch = parseConditionalEtagHeader(ifNoneMatch);
    }
  }
  {
    const ifModifiedSince = headers.get('if-modified-since');
    if (ifModifiedSince) {
      unwrapped.uploadedAfter = new Date(ifModifiedSince).getTime().toString();
    }
  }
  {
    const ifUnmodifiedSince = headers.get('if-unmodified-since');
    if (ifUnmodifiedSince) {
      unwrapped.uploadedBefore = new Date(ifUnmodifiedSince)
        .getTime()
        .toString();
    }
  }
  return unwrapped;
}

const isQuotedEtag = (etag: string) =>
  etag.startsWith(`"`) && etag.endsWith(`"`);

const buildSingleEtagArray = (value: string): [Etag] =>
  value === '*' ? [{ type: 'wildcard' }] : [{ type: 'strong', value }];

function unwrapConditionalObject(
  conditional: R2Conditional
): UnwrappedConditional {
  let unwrapped: UnwrappedConditional = {};
  if (conditional.etagMatches) {
    if (isQuotedEtag(conditional.etagMatches)) {
      throw new TypeError(
        `Condtional ETag should now be wrapped in quotes (${conditional.etagMatches}).`
      );
    }
    unwrapped.etagMatches = buildSingleEtagArray(conditional.etagMatches);
  }
  if (conditional.etagDoesNotMatch) {
    if (isQuotedEtag(conditional.etagDoesNotMatch)) {
      throw new TypeError(
        `Condtional ETag should now be wrapped in quotes (${conditional.etagDoesNotMatch}).`
      );
    }
    unwrapped.etagDoesNotMatch = buildSingleEtagArray(
      conditional.etagDoesNotMatch
    );
  }
  if (conditional.uploadedAfter) {
    unwrapped.uploadedAfter = conditional.uploadedAfter.getTime().toString();
  }
  if (conditional.uploadedBefore) {
    unwrapped.uploadedBefore = conditional.uploadedBefore.getTime().toString();
  }
  return unwrapped;
}

class R2Bucket implements R2Bucket {
  readonly #fetcher: Fetcher;

  public constructor(fetcher: Fetcher) {
    this.#fetcher = fetcher;
  }
  async head(object: string) {
    const res = await this.#fetcher.fetch('https://r2-binding.local', {
      headers: {
        'cf-r2-request': JSON.stringify({
          version: 1,
          method: 'head',
          object,
        }),
      },
    });
    if (!res.ok) {
      const maybeError = renderError(res);
      if (maybeError) {
        throw new R2Error(...maybeError);
      }
      return null;
    }
    const metadataSizeText = res.headers.get('cf-r2-metadata-size');
    if (!metadataSizeText) {
      // MIKKEL: Replace with real error
      throw new Error('Should not be reachable');
    }
    const metadataSize = Number(metadataSizeText);
    if (Number.isNaN(metadataSize)) {
      // MIKKEL: Replace with real error
      throw new Error('Should not be reachable');
    }
    if (!res.body) {
      // MIKKEL: Replace with real error
      throw new Error('Should not be reachable');
    }
    const reader = res.body.getReader({ mode: 'byob' });
    const { value: bytes } = await reader.read(new Uint8Array(metadataSize));
    const metadata = JSON.parse(
      new TextDecoder().decode(bytes)
    ) as R2HeadResponse;
    reader.releaseLock();
    return new R2Object(metadata);
  }
  async get(object: string, options?: R2GetOptions) {
    const req: any = {
      version: 1,
      method: 'get',
      object,
    };
    if (options) {
      if (options.onlyIf) {
        req.onlyIf = unwrapConditional(options.onlyIf);
      }
      if (options.range) {
        const range = options.range;
        if (range instanceof Headers) {
          const rangeHeader = range.get('range');
          if (rangeHeader) {
            req.rangeHeader = rangeHeader;
          }
        } else {
          if ('offset' in range && range.offset) {
            const offset = range.offset;
            if (offset < 0) {
              throw new RangeError(
                `Invalid range. Starting offset (${offset}) must be greater than or equal to 0.`
              );
            }
            if (!isWholeNumber(offset)) {
              throw new RangeError(
                `Invalid range. Starting offset (${offset}) must be an integer, not floating point.`
              );
            }
            req.range = {
              offset: offset.toString(),
            };
          }
          if ('length' in range && range.length) {
            const length = range.length;
            if (length < 0) {
              throw new RangeError(
                `Invalid range. Length (${length}) must be greater than or equal to 0.`
              );
            }
            if (!isWholeNumber(length)) {
              throw new RangeError(
                `Invalid range. Length (${length}) must be an integer, not floating point.`
              );
            }
            if (!req.range) {
              req.range = {};
            }
            req.range.length = length.toString();
          }
          if ('suffix' in range && range.suffix) {
            if ('offset' in range && range.offset) {
              throw new TypeError('Suffix is incompatible with offset.');
            }
            if ('length' in range && range.length) {
              throw new TypeError('Suffix is incompatible with length.');
            }
            const suffix = range.suffix;
            if (suffix < 0) {
              throw new RangeError(
                `Invalid suffix. Suffix (${suffix}) must be greater than or equal to 0.`
              );
            }
            if (!isWholeNumber(suffix)) {
              throw new RangeError(
                `Invalid range. Suffix (${suffix}) must be an integer, not floating point.`
              );
            }
            req.range = {
              suffix: suffix.toString(),
            };
          }
        }
      }
      if (options.ssecKey) {
        if (options.ssecKey instanceof ArrayBuffer) {
          req.ssecKey = bufTo64(options.ssecKey);
        } else if (typeof options.ssecKey === 'string') {
          // MIKKEL: Validate?
          req.ssecKey = options.ssecKey;
        }
      }
    }
    const res = await this.#fetcher.fetch('https://r2-binding.local', {
      headers: {
        'cf-r2-request': JSON.stringify(req),
      },
    });
    if (!res.ok) {
      const maybeError = renderError(res);
      if (maybeError) {
        throw new R2Error(...maybeError);
      }
      return null;
    }
    if (!res.body) {
      // MIKKEL: Replace with real error
      throw new Error('Should not be reachable');
    }
    const metadataSizeText = res.headers.get('cf-r2-metadata-size');
    if (!metadataSizeText) {
      // MIKKEL: Replace with real error
      throw new Error('Should not be reachable');
    }
    const metadataSize = Number(metadataSizeText);
    if (Number.isNaN(metadataSize)) {
      // MIKKEL: Replace with real error
      throw new Error('Should not be reachable');
    }
    const reader = res.body.getReader({ mode: 'byob' });
    const { done, value: bytes } = await reader.read(
      new Uint8Array(metadataSize)
    );
    const metadata = JSON.parse(
      new TextDecoder().decode(bytes)
    ) as R2HeadResponse;
    reader.releaseLock();
    if (options?.onlyIf && done) {
      return new R2Object(metadata);
    }
    return new R2ObjectBody(metadata, res.body);
  }
  async put(
    object: string,
    value: R2Body,
    options?: R2PutOptions
  ): Promise<R2Object | null> {
    const req: any = {
      version: 1,
      method: 'put',
      object,
    };
    if (options) {
      if (options.onlyIf) {
        req.onlyIf = unwrapConditional(options.onlyIf);
      }
      if (options.customMetadata) {
        req.customFields = Object.entries(options.customMetadata).map(
          ([k, v]) => ({ k, v })
        );
        console.log('honk', req.customFields);
      }
      if (options.httpMetadata) {
        let httpMetadata: R2HTTPMetadata;
        if (options.httpMetadata instanceof Headers) {
          httpMetadata = metadataFromHeaders(options.httpMetadata);
        } else {
          httpMetadata = options.httpMetadata;
        }
        req.httpFields = {
          ...httpMetadata,
          cacheExpiry: httpMetadata.cacheExpiry?.getTime().toString(),
        };
      }
      const md5 = validateBufHex('MD5', 16, options.md5);
      let hashSpecified = false;
      if (md5) {
        hashSpecified = true;
        req.md5 = md5;
      }
      const sha1 = validateBufHex('SHA-1', 20, options.sha1, hashSpecified);
      if (sha1) {
        hashSpecified = true;
        req.sha1 = sha1;
      }
      const sha256 = validateBufHex(
        'SHA-256',
        32,
        options.sha256,
        hashSpecified
      );
      if (sha256) {
        hashSpecified = true;
        req.sha256 = sha256;
      }
      const sha384 = validateBufHex(
        'SHA-384',
        48,
        options.sha384,
        hashSpecified
      );
      if (sha384) {
        hashSpecified = true;
        req.sha384 = sha384;
      }
      const sha512 = validateBufHex(
        'SHA-512',
        48,
        options.sha512,
        hashSpecified
      );
      if (sha512) {
        hashSpecified = true;
        req.sha512 = sha512;
      }
      if (typeof options.storageClass === 'string') {
        req.storageClass = options.storageClass;
      }
      const ssecKey = validateBufHex('SSEC-Key', 32, options.ssecKey);
      if (ssecKey) {
        req.ssec = {
          key: ssecKey,
        };
      }
    }
    const res = await this.#fetcher.fetch(createPutRequestInit(req, value));
    return new R2Object(await res.json());
  }
  async createMultipartUpload(
    object: string,
    options?: R2MultipartOptions
  ): Promise<R2MultipartUpload> {
    const req: any = {
      version: 1,
      method: 'createMultipartUpload',
      object,
    };
    if (options) {
      if (options.customMetadata) {
        req.customFields = Object.entries(options.customMetadata).map(
          ([k, v]) => ({ k, v })
        );
      }
      if (options.httpMetadata) {
        let httpMetadata: R2HTTPMetadata;
        if (options.httpMetadata instanceof Headers) {
          httpMetadata = metadataFromHeaders(options.httpMetadata);
        } else {
          httpMetadata = options.httpMetadata;
        }
        req.httpFields = {
          ...httpMetadata,
          cacheExpiry: httpMetadata.cacheExpiry?.getTime().toString(),
        };
      }
      if (typeof options.storageClass === 'string') {
        req.storageClass = options.storageClass;
      }
      const ssecKey = validateBufHex('SSEC-Key', 32, options.ssecKey);
      if (ssecKey) {
        req.ssec = {
          key: ssecKey,
        };
      }
    }
    const res = await this.#fetcher.fetch(createPutRequestInit(req));
    if (!res.ok) {
      const maybeError = renderError(res);
      if (maybeError) {
        throw new R2Error(...maybeError);
      }
    }
    const { uploadId } = (await res.json()) as { uploadId: string };
    return new R2MultipartUpload(this.#fetcher, object, uploadId);
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    return new R2MultipartUpload(this.#fetcher, key, uploadId);
  }
  async delete(objects: string | string[]) {
    const req: any = {
      version: 1,
      method: 'delete',
    };
    if (typeof objects === 'string') {
      req.object = objects;
    } else if (Array.isArray(objects)) {
      req.objects = objects;
    }
    const res = await this.#fetcher.fetch(createPutRequestInit(req));
    if (!res.ok) {
      const maybeError = renderError(res);
      if (maybeError) {
        throw new R2Error(...maybeError);
      }
    }
  }
  async list(options?: R2ListOptions) {
    const req: any = {
      version: 1,
      method: 'list',
      limit: options?.limit,
      prefix: options?.prefix,
      cursor: options?.cursor,
      delimiter: options?.delimiter,
      startAfter: options?.startAfter,
      include: [],
    };
    if (options?.include) {
      for (const include of options.include) {
        if (include === 'httpMetadata') {
          req.include.push(0);
        } else if (include === 'customMetadata') {
          req.include.push(1);
        } else {
          throw new RangeError(`Unsupported include value ${include}`);
        }
      }
    }
    const res = await this.#fetcher.fetch('https://r2-binding.local', {
      headers: {
        'cf-r2-request': JSON.stringify(req),
      },
    });
    if (!res.ok) {
      const maybeError = renderError(res);
      if (maybeError) {
        throw new R2Error(...maybeError);
      }
    }
    const body = (await res.json()) as {
      objects: ConstructorParameters<typeof R2Object>[0][];
      truncated: boolean;
      cursor: string;
      delimitedPrefixes: string[];
    };
    return {
      ...body,
      objects: body.objects.map((objectInit) => new R2Object(objectInit)),
    };
  }
}

function makeBinding(env: { fetcher: Fetcher }): R2Bucket {
  return new R2Bucket(env.fetcher);
}

export default makeBinding;
