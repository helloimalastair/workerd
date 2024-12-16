// Copyright (c) 2023 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import assert from 'node:assert';

const key = 'basicKey';
const body = 'content';
const httpMetaObj = {
  contentType: 'text/plain',
  contentLanguage: 'en-US',
  contentDisposition: 'attachment; filename = "basicKey.txt"',
  contentEncoding: 'utf-8',
  cacheControl: 'no-store',
  cacheExpiry: new Date(1e3),
};
const httpFields = {
  ...httpMetaObj,
  cacheExpiry: '1000',
};
const httpMetaHeaders = new Headers({
  'content-type': httpMetaObj.contentType,
  'content-language': httpMetaObj.contentLanguage,
  'content-disposition': httpMetaObj.contentDisposition,
  'content-encoding': httpMetaObj.contentEncoding,
  'cache-control': httpMetaObj.cacheControl,
  expires: httpMetaObj.cacheExpiry.toUTCString(),
});
const customMetadata = {
  foo: 'bar',
  baz: 'qux',
};
const customFields = Object.entries(customMetadata).map(([k, v]) => ({ k, v }));
const bufferKey = new Uint8Array([
  185, 255, 145, 154, 120, 76, 122, 72, 191, 42, 8, 64, 86, 189, 185, 75, 105,
  37, 155, 123, 165, 158, 4, 42, 222, 13, 135, 52, 87, 154, 181, 227,
]);
const hexKey =
  'b9ff919a784c7a48bf2a084056bdb94b69259b7ba59e042ade0d8734579ab5e3';
const keyMd5 = 'WGR5pEm07DroP3hYRAh8Yw==';
const conditionalDate = '946684800000';

const objResponse = {
  name: key,
  version: 'objectVersion',
  size: '123',
  etag: 'objectEtag',
  uploaded: '1724767257918',
  storageClass: 'Standard',
};
const HeadObject = {
  ssecKeyMd5: undefined,
  storageClass: 'Standard',
  range: undefined,
  customMetadata: {},
  httpMetadata: {},
  uploaded: new Date(Number(objResponse.uploaded)),
  checksums: {
    sha512: undefined,
    sha384: undefined,
    sha256: undefined,
    sha1: undefined,
    md5: undefined,
  },
  httpEtag: '"objectEtag"',
  etag: 'objectEtag',
  size: 123,
  version: 'objectVersion',
  key,
};

function buildGetResponse({ head, body, isList } = {}) {
  const encoder = new TextEncoder();
  let meta;
  if (!isList) {
    meta = {
      ...objResponse,
    };
  }
  meta = {
    ...meta,
    ...head,
  };
  const metadata = encoder.encode(JSON.stringify(meta));
  const responseBody = body
    ? new ReadableStream({
        start(controller) {
          controller.enqueue(metadata);
          controller.enqueue(encoder.encode(body));
          controller.close();
        },
      })
    : metadata;
  return new Response(responseBody, {
    headers: {
      'cf-r2-metadata-size': metadata.length.toString(),
      'content-length': metadata.length.toString(),
    },
  });
}
async function compareResponse(res, { head, body } = {}) {
  // Destructuring syntax looks ugly, but gets around needing to construct HeadResponse objects(somehow?)
  const { ...obj } = await res;
  obj.checksums = { ...obj.checksums };
  assert.deepEqual(obj, {
    ...HeadObject,
    ...head,
  });
  if (body) {
    assert.strictEqual(await (await res).text(), body);
  }
}

export default {
  // Handler for HTTP request binding makes to R2
  async fetch(request, env, ctx) {
    // We only expect PUT/Get
    assert(['GET', 'PUT'].includes(request.method));

    switch (request.method) {
      case 'PUT': {
        // Each request should have a metadata size header indicating how much
        // we should read to understand what type of request this is
        const metadataSizeString = request.headers.get('cf-r2-metadata-size');
        assert.notStrictEqual(metadataSizeString, null);

        const metadataSize = parseInt(metadataSizeString);
        assert(!Number.isNaN(metadataSize));

        const reader = request.body.getReader({ mode: 'byob' });
        const buffer = new ArrayBuffer(metadataSize);
        const firstChunk = new Uint8Array(buffer);
        const { value } = await reader.readAtLeast(metadataSize, firstChunk);
        reader.releaseLock();

        const jsonRequest = JSON.parse(new TextDecoder().decode(value));

        // Currently not using the body in these test so I'm going to just discard
        for await (const _ of request.body) {
        }

        // Assert it's the correct version
        assert((jsonRequest.version = 1));

        if (jsonRequest.method === 'delete') {
          if (jsonRequest.objects) {
            assert.deepEqual(jsonRequest.objects, [key, key + '2']);
          } else {
            assert.deepEqual(jsonRequest.object, key);
          }
          return new Response();
        }

        switch (jsonRequest.object) {
          case 'basicKey': {
            switch (jsonRequest.method) {
              case 'put': {
                break;
              }
              case 'createMultipartUpload': {
                return Response.json({
                  uploadId: 'multipartId',
                });
              }
              case 'uploadPart': {
                return Response.json({
                  etag: 'partEtag',
                });
              }
              case 'abortMultipartUpload': {
                return new Response();
              }
              case 'completeMultipartUpload': {
                return Response.json(objResponse);
              }
            }
            break;
          }
          case 'onlyIfStrongEtag': {
            assert.deepStrictEqual(jsonRequest.onlyIf, {
              etagMatches: [
                {
                  value: 'strongEtag',
                  type: 'strong',
                },
              ],
              etagDoesNotMatch: [
                {
                  value: 'strongEtag',
                  type: 'strong',
                },
              ],
              uploadedBefore: conditionalDate,
            });
            break;
          }
          case 'onlyIfWildcard': {
            assert.deepStrictEqual(jsonRequest.onlyIf, {
              etagMatches: [
                {
                  type: 'wildcard',
                },
              ],
              etagDoesNotMatch: [
                {
                  type: 'wildcard',
                },
              ],
              uploadedAfter: conditionalDate,
            });
            break;
          }
          case 'httpMetadata': {
            if (jsonRequest.method !== 'completeMultipartUpload') {
              assert.deepEqual(jsonRequest.httpFields, httpFields);
            }
            const head = {
              ...objResponse,
              httpFields,
            };
            switch (jsonRequest.method) {
              case 'put':
                return Response.json(head);
              case 'createMultipartUpload':
                return Response.json({
                  uploadId: 'multipartId',
                });
              case 'completeMultipartUpload': {
                return Response.json(head);
              }
            }
          }
          case 'customMetadata': {
            if (jsonRequest.method !== 'completeMultipartUpload') {
              assert.deepEqual(jsonRequest.customFields, customFields);
            }
            const head = {
              ...objResponse,
              customFields,
            };
            switch (jsonRequest.method) {
              case 'put':
                return Response.json(head);
              case 'createMultipartUpload':
                return Response.json({
                  uploadId: 'multipartId',
                });
              case 'completeMultipartUpload':
                return Response.json(head);
            }
          }
          case 'classDefault': {
            if (jsonRequest.method !== 'completeMultipartUpload') {
              assert.strictEqual(jsonRequest.storageClass, undefined);
            }
            const head = objResponse;
            switch (jsonRequest.method) {
              case 'put':
                return Response.json(head);
              case 'createMultipartUpload':
                return Response.json({
                  uploadId: 'multipartId',
                });
              case 'completeMultipartUpload':
                return Response.json(head);
            }
          }
          case 'classStandard': {
            if (jsonRequest.method !== 'completeMultipartUpload') {
              assert.deepEqual(jsonRequest.storageClass, 'Standard');
            }
            const head = {
              ...objResponse,
              storageClass: 'Standard',
            };
            switch (jsonRequest.method) {
              case 'put':
                return Response.json(head);
              case 'createMultipartUpload':
                return Response.json({
                  uploadId: 'multipartId',
                });
              case 'completeMultipartUpload':
                return Response.json(head);
            }
          }
          case 'classInfrequentAccess': {
            if (jsonRequest.method !== 'completeMultipartUpload') {
              assert.deepEqual(jsonRequest.storageClass, 'InfrequentAccess');
            }
            const head = {
              ...objResponse,
              storageClass: 'InfrequentAccess',
            };
            switch (jsonRequest.method) {
              case 'put':
                return Response.json(head);
              case 'createMultipartUpload':
                return Response.json({
                  uploadId: 'multipartId',
                });
              case 'completeMultipartUpload':
                return Response.json(head);
            }
          }
          case 'ssec': {
            assert.deepStrictEqual(jsonRequest.ssec, {
              key: hexKey,
            });
            return Response.json({
              ...objResponse,
              ssec: {
                algorithm: 'aes256',
                keyMd5,
              },
            });
          }
          case 'ssecMultipart': {
            if (jsonRequest.method === 'createMultipartUpload') {
              assert.deepStrictEqual(jsonRequest.ssec, {
                key: hexKey,
              });
              return Response.json({
                uploadId: 'multipartId',
              });
            }
            if (jsonRequest.method === 'uploadPart') {
              assert.deepStrictEqual(jsonRequest.ssec, {
                key: hexKey,
              });
              return Response.json({
                etag: 'partEtag',
                ssec: {
                  algorithm: 'aes256',
                  keyMd5,
                },
              });
            }
            if (jsonRequest.method === 'completeMultipartUpload') {
              return Response.json({
                ...objResponse,
                ssec: {
                  algorithm: 'aes256',
                  keyMd5,
                },
              });
            }
          }
        }
        return Response.json(objResponse);
      }
      case 'GET': {
        const rawHeader = request.headers.get('cf-r2-request');
        const jsonRequest = JSON.parse(rawHeader);
        assert((jsonRequest.version = 1));
        if (jsonRequest.method === 'list') {
          switch (jsonRequest.prefix) {
            case 'basic': {
              assert.deepEqual(jsonRequest, {
                cursor: 'ai',
                delimiter: '/',
                include: [0, 1],
                limit: 1,
                method: 'list',
                // newRuntime: true,
                prefix: 'basic',
                version: 1,
              });
              return buildGetResponse({
                head: {
                  objects: [objResponse],
                  truncated: true,
                  cursor: 'ai',
                  delimitedPrefixes: [],
                },
                isList: true,
              });
            }
            case 'httpMeta': {
              assert.deepEqual(jsonRequest, {
                include: [0],
                method: 'list',
                // newRuntime: true,
                prefix: 'httpMeta',
                version: 1,
              });

              return buildGetResponse({
                head: {
                  objects: [{ ...objResponse, httpFields, customFields: [] }],
                  truncated: false,
                  delimitedPrefixes: [],
                },
                isList: true,
              });
            }
            case 'customMeta': {
              assert.deepEqual(jsonRequest, {
                include: [1],
                method: 'list',
                // newRuntime: true,
                prefix: 'customMeta',
                version: 1,
              });

              return buildGetResponse({
                head: {
                  objects: [{ ...objResponse, httpFields: {}, customFields }],
                  truncated: false,
                  delimitedPrefixes: [],
                },
                isList: true,
              });
            }
          }
        }
        assert(['get', 'head'].includes(jsonRequest.method));
        switch (jsonRequest.object) {
          case 'basicKey': {
            if (jsonRequest.method === 'get') {
              return buildGetResponse({ body });
            }
            return buildGetResponse();
          }
          case 'rangeOffLen': {
            assert.deepEqual(jsonRequest.range, {
              offset: '1',
              length: '3',
            });
            return buildGetResponse({
              head: {
                range: jsonRequest.range,
              },
              body: 'ont',
            });
          }
          case 'rangeSuff': {
            assert.deepEqual(jsonRequest.range, {
              suffix: '2',
            });
            return buildGetResponse({
              head: {
                range: {
                  offset: '6',
                  length: '2',
                },
              },
              body: 'nt',
            });
          }
          case 'onlyIfStrongEtag': {
            assert.deepStrictEqual(jsonRequest.onlyIf, {
              etagMatches: [
                {
                  value: 'strongEtag',
                  type: 'strong',
                },
              ],
              etagDoesNotMatch: [
                {
                  value: 'strongEtag',
                  type: 'strong',
                },
              ],
              uploadedBefore: conditionalDate,
            });
            return buildGetResponse({ body });
          }
          case 'onlyIfWildcard': {
            assert.deepStrictEqual(jsonRequest.onlyIf, {
              etagMatches: [
                {
                  type: 'wildcard',
                },
              ],
              etagDoesNotMatch: [
                {
                  type: 'wildcard',
                },
              ],
              uploadedAfter: conditionalDate,
            });
            return buildGetResponse({ body });
          }
          case 'httpMetadata': {
            const head = {
              httpFields,
            };
            switch (jsonRequest.method) {
              case 'head':
                return buildGetResponse({ head });
              case 'get':
                return buildGetResponse({ head, body });
            }
          }
          case 'customMetadata': {
            const head = {
              customFields,
            };
            switch (jsonRequest.method) {
              case 'head':
                return buildGetResponse({ head });
              case 'get':
                return buildGetResponse({ head, body });
            }
          }
          case 'classDefault':
          case 'classStandard': {
            const head = {
              storageClass: 'Standard',
            };
            switch (jsonRequest.method) {
              case 'head':
                return buildGetResponse({ head });
              case 'get':
                return buildGetResponse({ head, body });
            }
          }
          case 'classInfrequentAccess': {
            const head = {
              storageClass: 'InfrequentAccess',
            };
            switch (jsonRequest.method) {
              case 'head':
                return buildGetResponse({ head });
              case 'get':
                return buildGetResponse({ head, body });
            }
          }
          case 'ssec': {
            return buildGetResponse({
              head: {
                ssec: {
                  algorithm: 'aes256',
                  keyMd5,
                },
              },
              body,
            });
          }
        }
        throw new Error('Unexpected GET');
      }
      default:
        throw new Error('Unexpected HTTP Method');
    }
  },
};
