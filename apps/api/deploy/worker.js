// SPDX-License-Identifier: MIT
// PayLink API (PayPal edition): Cloudflare Worker bundle. GENERATED, DO NOT EDIT.
// Built by apps/api/scripts/build.ts from apps/api/src/worker/index.ts with rolldown, not minified.
// Registry: the shipped @paylink/chains registry. No key, no wallet client: the API never signs or sends a transaction.
// Third-party code: @noble/hashes@1.8.0, hono@4.13.13, viem@2.57.3 (all MIT; texts in LICENSES.txt). Checksums: SHA256SUMS.
// Rebuild: pnpm --filter @paylink/api run build   Check: pnpm --filter @paylink/api run build:check
import { DurableObject } from "cloudflare:workers";

//#region apps/api/\0rolldown/runtime.js
var __esmMin = (fn, res, err) => () => {
	if (err) throw err[0];
	try {
		return fn && (res = fn(fn = 0)), res;
	} catch (e) {
		throw err = [e], e;
	}
};

//#endregion
//#region packages/api-contract/src/common.ts
/** The only chain of the PayPal edition (decision D-CHAIN, ADR 0018): Ethereum Sepolia. */
const PAYPAL_EDITION_CHAIN_ID = 11155111;
/**
* The route table of `apps/api` (docs/paypal/SPEC.md §13). Cut by D-SCOPE and therefore absent: `POST /v1/desk/ask` (the
* free-text desk question). Every route answers 501 `not-implemented` until its workstream implements it, except
* `GET /v1/health`.
*/
const API_ROUTES = [
	{
		id: "session.create",
		method: "POST",
		path: "/v1/session",
		auth: "signature",
		owner: "reconciler",
		purpose: "Verify a signed PayLinkSession; return a session token"
	},
	{
		id: "ai.draft",
		method: "POST",
		path: "/v1/ai/draft",
		auth: "session",
		owner: "ai",
		purpose: "A1: a client message to an invoice draft"
	},
	{
		id: "twin.create",
		method: "POST",
		path: "/v1/twin",
		auth: "session",
		owner: "paypal-spine",
		purpose: "Verify the signed link, then P2, (P3, P4), P5: the PayPal twin"
	},
	{
		id: "twin.get",
		method: "GET",
		path: "/v1/twin/:key",
		auth: "session",
		owner: "paypal-spine",
		purpose: "The payee's twin, its situation and last check"
	},
	{
		id: "rails.get",
		method: "GET",
		path: "/v1/rails/:key",
		auth: "public",
		owner: "paypal-spine",
		purpose: "The PayPal rail of a link, for the pay page"
	},
	{
		id: "paypal.webhook",
		method: "POST",
		path: "/v1/paypal/webhook",
		auth: "paypal",
		owner: "paypal-spine",
		purpose: "Verified PayPal webhook: P10, then P5, then reconcile"
	},
	{
		id: "desk.get",
		method: "GET",
		path: "/v1/desk",
		auth: "session",
		owner: "reconciler",
		purpose: "Proposals, auto-records and alerts"
	},
	{
		id: "desk.sweep",
		method: "POST",
		path: "/v1/desk/sweep",
		auth: "session",
		owner: "reconciler",
		purpose: "Reconcile every twin, then run the A2 desk once"
	},
	{
		id: "desk.approve",
		method: "POST",
		path: "/v1/desk/:id/approve",
		auth: "session",
		owner: "reconciler",
		purpose: "Executor: fresh read, fence, act"
	},
	{
		id: "desk.reject",
		method: "POST",
		path: "/v1/desk/:id/reject",
		auth: "session",
		owner: "reconciler",
		purpose: "Close a proposal"
	},
	{
		id: "desk.undo",
		method: "POST",
		path: "/v1/desk/:id/undo",
		auth: "session",
		owner: "reconciler",
		purpose: "P7 within 24 h of an auto-record"
	},
	{
		id: "check",
		method: "POST",
		path: "/v1/check",
		auth: "session",
		owner: "reconciler",
		purpose: "Was I really paid? Deterministic verdict from P5 and the chain"
	},
	{
		id: "health",
		method: "GET",
		path: "/v1/health",
		auth: "public",
		owner: "foundation",
		purpose: "Status rows: PayPal, webhook, assistant, chain, store"
	}
];
/** Header of the per-request id, echoed in every response and problem. */
const REQUEST_ID_HEADER = "X-Request-Id";
/**
* Stable problem codes. Clients branch on `code` (and `rule`), never on `detail`. A domain error of the specification
* (`E_STALE`, `E_TWIN_PRECISION`, `E_PAYPAL_SCHEDULED`, …) travels as `rule`.
*/
const API_PROBLEMS = {
	"invalid-json": {
		status: 400,
		title: "The request body is not valid JSON"
	},
	"invalid-request": {
		status: 400,
		title: "The request does not match the schema"
	},
	"unsupported-media-type": {
		status: 415,
		title: "The request body must be application/json"
	},
	"payload-too-large": {
		status: 413,
		title: "The request body is too large"
	},
	unauthorized: {
		status: 401,
		title: "A valid session is required"
	},
	forbidden: {
		status: 403,
		title: "This session may not do this"
	},
	"origin-not-allowed": {
		status: 403,
		title: "This origin may not call the API"
	},
	"not-found": {
		status: 404,
		title: "No such resource"
	},
	"method-not-allowed": {
		status: 405,
		title: "Method not allowed"
	},
	stale: {
		status: 409,
		title: "The situation changed: read it again"
	},
	conflict: {
		status: 409,
		title: "The request conflicts with the current state"
	},
	"rate-limited": {
		status: 429,
		title: "Too many requests"
	},
	"quota-exhausted": {
		status: 429,
		title: "The daily quota is used up"
	},
	"webhook-rejected": {
		status: 400,
		title: "The webhook did not verify"
	},
	"paypal-rejected": {
		status: 502,
		title: "PayPal refused the request"
	},
	"paypal-unavailable": {
		status: 503,
		title: "PayPal did not answer"
	},
	"chain-unavailable": {
		status: 503,
		title: "The chain could not be read"
	},
	"assistant-unavailable": {
		status: 503,
		title: "The assistant is not available"
	},
	"not-implemented": {
		status: 501,
		title: "Not implemented yet"
	},
	internal: {
		status: 500,
		title: "Internal error"
	}
};

//#endregion
//#region hono@4.13.13/dist/request/constants.js
const GET_MATCH_RESULT = Symbol();

//#endregion
//#region hono@4.13.13/dist/utils/buffer.js
const bufferToFormData = (arrayBuffer, contentType) => {
	return new Response(arrayBuffer, { headers: { "Content-Type": contentType.replace(/^[^;]+/, (mediaType) => mediaType.toLowerCase()) } }).formData();
};

//#endregion
//#region hono@4.13.13/dist/utils/body.js
const MAX_NESTED_OBJECTS = 1e4;
const isRawRequest = (request) => "headers" in request;
const parseBody = async (request, options = Object.create(null)) => {
	const { all = false, dot = false } = options;
	const mediaType = (isRawRequest(request) ? request.headers : request.raw.headers).get("Content-Type")?.split(";")[0].trim().toLowerCase();
	if (mediaType === "multipart/form-data" || mediaType === "application/x-www-form-urlencoded") return parseFormData(request, {
		all,
		dot
	});
	return {};
};
/**
* Parses form data from a request.
*
* @template T - The type of the parsed body data.
* @param {HonoRequest | Request} request - The request object containing form data.
* @param {ParseBodyOptions} options - Options for parsing the form data.
* @returns {Promise<T>} The parsed body data.
*/
async function parseFormData(request, options) {
	if (!isRawRequest(request) && request.bodyCache.formData) return convertFormDataToBodyData(await request.bodyCache.formData, options);
	const headers = isRawRequest(request) ? request.headers : request.raw.headers;
	const arrayBuffer = await request.arrayBuffer();
	const formDataPromise = bufferToFormData(arrayBuffer, headers.get("Content-Type") || "");
	if (!isRawRequest(request)) request.bodyCache.formData = formDataPromise;
	const formData = await formDataPromise;
	if (formData) return convertFormDataToBodyData(formData, options);
	return {};
}
/**
* Converts form data to body data based on the provided options.
*
* @template T - The type of the parsed body data.
* @param {FormData} formData - The form data to convert.
* @param {ParseBodyOptions} options - Options for parsing the form data.
* @returns {T} The converted body data.
*/
function convertFormDataToBodyData(formData, options) {
	const form = Object.create(null);
	const nestingState = { count: 0 };
	formData.forEach((value, key) => {
		if (!(options.all || key.endsWith("[]"))) form[key] = value;
		else handleParsingAllValues(form, key, value);
	});
	if (options.dot) Object.entries(form).forEach(([key, value]) => {
		if (key.includes(".")) {
			handleParsingNestedValues(form, key, value, nestingState);
			delete form[key];
		}
	});
	return form;
}
/**
* Handles parsing all values for a given key, supporting multiple values as arrays.
*
* @param {BodyData} form - The form data object.
* @param {string} key - The key to parse.
* @param {FormDataEntryValue} value - The value to assign.
*/
const handleParsingAllValues = (form, key, value) => {
	if (form[key] !== void 0) {
		if (Array.isArray(form[key])) form[key].push(value);
		else form[key] = [form[key], value];
	} else if (!key.endsWith("[]")) form[key] = value;
	else form[key] = [value];
};
/**
* Handles parsing nested values using dot notation keys.
*
* @param {BodyData} form - The form data object.
* @param {string} key - The dot notation key.
* @param {BodyDataValue} value - The value to assign.
*/
const handleParsingNestedValues = (form, key, value, state) => {
	if (/(?:^|\.)__proto__\./.test(key)) return;
	let nestedForm = form;
	const keys = key.split(".", 34);
	if (keys.length > 33) throwNestingLimitExceeded();
	keys.forEach((key, index) => {
		if (index === keys.length - 1) nestedForm[key] = value;
		else {
			if (!nestedForm[key] || typeof nestedForm[key] !== "object" || Array.isArray(nestedForm[key]) || nestedForm[key] instanceof File) {
				if (state.count++ >= MAX_NESTED_OBJECTS) throwNestingLimitExceeded();
				nestedForm[key] = Object.create(null);
			}
			nestedForm = nestedForm[key];
		}
	});
};
const throwNestingLimitExceeded = () => {
	throw new Error("Nesting limit exceeded");
};

//#endregion
//#region hono@4.13.13/dist/utils/url.js
const splitPath = (path) => {
	const paths = path.split("/");
	if (paths[0] === "") paths.shift();
	return paths;
};
const splitRoutingPath = (routePath) => {
	const { groups, path } = extractGroupsFromPath(routePath);
	const paths = splitPath(path);
	return replaceGroupMarks(paths, groups);
};
const extractGroupsFromPath = (path) => {
	const groups = [];
	path = path.replace(/\{[^}]+\}/g, (match, index) => {
		const mark = `@${index}`;
		groups.push([mark, match]);
		return mark;
	});
	return {
		groups,
		path
	};
};
const replaceGroupMarks = (paths, groups) => {
	for (let i = groups.length - 1; i >= 0; i--) {
		const [mark] = groups[i];
		for (let j = paths.length - 1; j >= 0; j--) if (paths[j].includes(mark)) {
			paths[j] = paths[j].replace(mark, groups[i][1]);
			break;
		}
	}
	return paths;
};
const patternCache = {};
const getPattern = (label, next) => {
	if (label === "*") return "*";
	const match = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
	if (match) {
		const cacheKey = `${label}#${next}`;
		if (!patternCache[cacheKey]) {
			if (match[2]) patternCache[cacheKey] = next && next[0] !== ":" && next[0] !== "*" ? [
				cacheKey,
				match[1],
				new RegExp(`^${match[2]}(?=/${next})`)
			] : [
				label,
				match[1],
				new RegExp(`^${match[2]}$`)
			];
			else patternCache[cacheKey] = [
				label,
				match[1],
				true
			];
		}
		return patternCache[cacheKey];
	}
	return null;
};
const tryDecode = (str, decoder) => {
	try {
		return decoder(str);
	} catch {
		return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
			try {
				return decoder(match);
			} catch {
				return match;
			}
		});
	}
};
/**
* Try to apply decodeURI() to given string.
* If it fails, skip invalid percent encoding or invalid UTF-8 sequences, and apply decodeURI() to the rest as much as possible.
* @param str The string to decode.
* @returns The decoded string that sometimes contains undecodable percent encoding.
* @example
* tryDecodeURI('Hello%20World') // 'Hello World'
* tryDecodeURI('Hello%20World/%A4%A2') // 'Hello World/%A4%A2'
*/
const tryDecodeURI = (str) => tryDecode(str, decodeURI);
const getPath = (request) => {
	const url = request.url;
	const start = url.indexOf("/", url.indexOf(":") + 4);
	let i = start;
	for (; i < url.length; i++) {
		const charCode = url.charCodeAt(i);
		if (charCode === 37) {
			const queryIndex = url.indexOf("?", i);
			const hashIndex = url.indexOf("#", i);
			const end = queryIndex === -1 ? hashIndex === -1 ? void 0 : hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
			const path = url.slice(start, end);
			return tryDecodeURI(path.includes("%25") ? path.replace(/%25/g, "%2525") : path);
		} else if (charCode === 63 || charCode === 35) break;
	}
	return url.slice(start, i);
};
const getPathNoStrict = (request) => {
	const result = getPath(request);
	return result.length > 1 && result.at(-1) === "/" ? result.slice(0, -1) : result;
};
/**
* Merge paths.
* @param {string[]} ...paths - The paths to merge.
* @returns {string} The merged path.
* @example
* mergePath('/api', '/users') // '/api/users'
* mergePath('/api/', '/users') // '/api/users'
* mergePath('/api', '/') // '/api'
* mergePath('/api/', '/') // '/api/'
*/
const mergePath = (base, sub, ...rest) => {
	if (rest.length) sub = mergePath(sub, ...rest);
	return `${base?.[0] === "/" ? "" : "/"}${base}${sub === "/" ? "" : `${base?.at(-1) === "/" ? "" : "/"}${sub?.[0] === "/" ? sub.slice(1) : sub}`}`;
};
const checkOptionalParameter = (path) => {
	if (path.charCodeAt(path.length - 1) !== 63 || !path.includes(":")) return null;
	const segments = path.split("/");
	const results = [];
	let basePath = "";
	segments.forEach((segment) => {
		if (segment !== "" && !/\:/.test(segment)) basePath += "/" + segment;
		else if (/\:/.test(segment)) {
			if (segment.charCodeAt(segment.length - 1) === 63) {
				if (results.length === 0 && basePath === "") results.push("/");
				else results.push(basePath);
				const optionalSegment = segment.slice(0, -1);
				basePath += "/" + optionalSegment;
				results.push(basePath);
			} else basePath += "/" + segment;
		}
	});
	return results.filter((v, i, a) => a.indexOf(v) === i);
};
const tryDecodeURIComponent = (str) => str.indexOf("%") !== -1 ? tryDecode(str, decodeURIComponent_) : str;
const _decodeURI = (value) => {
	if (value.indexOf("+") !== -1) value = value.replace(/\+/g, " ");
	return tryDecodeURIComponent(value);
};
const _getQueryParam = (url, key, multiple) => {
	const hashIndex = url.indexOf("#", 8);
	if (hashIndex !== -1) url = url.slice(0, hashIndex);
	let encoded;
	if (!multiple && key && key.indexOf("%") === -1 && key.indexOf("+") === -1) {
		let keyIndex = url.indexOf("?", 8);
		if (keyIndex === -1) return;
		if (!url.startsWith(key, keyIndex + 1)) keyIndex = url.indexOf(`&${key}`, keyIndex + 1);
		while (keyIndex !== -1) {
			const trailingKeyCode = url.charCodeAt(keyIndex + key.length + 1);
			if (trailingKeyCode === 61) {
				const valueIndex = keyIndex + key.length + 2;
				const endIndex = url.indexOf("&", valueIndex);
				return _decodeURI(url.slice(valueIndex, endIndex === -1 ? void 0 : endIndex));
			} else if (trailingKeyCode == 38 || isNaN(trailingKeyCode)) return "";
			keyIndex = url.indexOf(`&${key}`, keyIndex + 1);
		}
		encoded = /[%+]/.test(url);
		if (!encoded) return;
	}
	const results = Object.create(null);
	encoded ??= /[%+]/.test(url);
	let keyIndex = url.indexOf("?", 8);
	while (keyIndex !== -1) {
		const nextKeyIndex = url.indexOf("&", keyIndex + 1);
		let valueIndex = url.indexOf("=", keyIndex);
		if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) valueIndex = -1;
		let name = url.slice(keyIndex + 1, valueIndex === -1 ? nextKeyIndex === -1 ? void 0 : nextKeyIndex : valueIndex);
		if (encoded) name = _decodeURI(name);
		keyIndex = nextKeyIndex;
		if (name === "") continue;
		let value;
		if (valueIndex === -1) value = "";
		else {
			value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? void 0 : nextKeyIndex);
			if (encoded) value = _decodeURI(value);
		}
		if (multiple) {
			if (!(results[name] && Array.isArray(results[name]))) results[name] = [];
			results[name].push(value);
		} else results[name] ??= value;
	}
	return key ? results[key] : results;
};
const getQueryParam = _getQueryParam;
const getQueryParams = (url, key) => {
	return _getQueryParam(url, key, true);
};
const decodeURIComponent_ = decodeURIComponent;

//#endregion
//#region hono@4.13.13/dist/request.js
var HonoRequest = class {
	/**
	* `.raw` can get the raw Request object.
	*
	* @see {@link https://hono.dev/docs/api/request#raw}
	*
	* @example
	* ```ts
	* // For Cloudflare Workers
	* app.post('/', async (c) => {
	*   const metadata = c.req.raw.cf?.hostMetadata?
	*   ...
	* })
	* ```
	*/
	raw;
	#validatedData;
	#matchResult;
	routeIndex = 0;
	/**
	* `.path` can get the pathname of the request.
	*
	* @see {@link https://hono.dev/docs/api/request#path}
	*
	* @example
	* ```ts
	* app.get('/about/me', (c) => {
	*   const pathname = c.req.path // `/about/me`
	* })
	* ```
	*/
	path;
	bodyCache = {};
	constructor(request, path = "/", matchResult = [[]]) {
		this.raw = request;
		this.path = path;
		this.#matchResult = matchResult;
	}
	param(key) {
		return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams();
	}
	#getDecodedParam(key) {
		const paramKey = this.#matchResult[0][this.routeIndex]?.[1][key];
		const param = this.#getParamValue(paramKey);
		return param && tryDecodeURIComponent(param);
	}
	#getAllDecodedParams() {
		const decoded = {};
		const keys = Object.keys(this.#matchResult[0][this.routeIndex]?.[1] ?? {});
		for (const key of keys) {
			const value = this.#getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
			if (value !== void 0) decoded[key] = tryDecodeURIComponent(value);
		}
		return decoded;
	}
	#getParamValue(paramKey) {
		return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
	}
	query(key) {
		return getQueryParam(this.url, key);
	}
	queries(key) {
		return getQueryParams(this.url, key);
	}
	header(name) {
		if (name) return this.raw.headers.get(name) ?? void 0;
		const headerData = Object.create(null);
		this.raw.headers.forEach((value, key) => {
			headerData[key] = value;
		});
		return headerData;
	}
	async parseBody(options) {
		return parseBody(this, options);
	}
	#cachedBody = (key) => {
		const { bodyCache, raw } = this;
		const cachedBody = bodyCache[key];
		if (cachedBody) return cachedBody;
		for (const anyCachedKey in bodyCache) return bodyCache[anyCachedKey].then((body) => {
			if (anyCachedKey === "json") body = JSON.stringify(body);
			const contentType = anyCachedKey === "formData" ? void 0 : raw.headers.get("content-type");
			return new Response(body, { headers: contentType ? { "Content-Type": contentType } : void 0 })[key]();
		});
		return bodyCache[key] = raw[key]();
	};
	/**
	* `.json()` can parse Request body of type `application/json`
	*
	* @see {@link https://hono.dev/docs/api/request#json}
	*
	* @example
	* ```ts
	* app.post('/entry', async (c) => {
	*   const body = await c.req.json()
	* })
	* ```
	*/
	json() {
		return this.#cachedBody("text").then((text) => JSON.parse(text));
	}
	/**
	* `.text()` can parse Request body of type `text/plain`
	*
	* @see {@link https://hono.dev/docs/api/request#text}
	*
	* @example
	* ```ts
	* app.post('/entry', async (c) => {
	*   const body = await c.req.text()
	* })
	* ```
	*/
	text() {
		return this.#cachedBody("text");
	}
	/**
	* `.arrayBuffer()` parse Request body as an `ArrayBuffer`
	*
	* @see {@link https://hono.dev/docs/api/request#arraybuffer}
	*
	* @example
	* ```ts
	* app.post('/entry', async (c) => {
	*   const body = await c.req.arrayBuffer()
	* })
	* ```
	*/
	arrayBuffer() {
		return this.#cachedBody("arrayBuffer");
	}
	/**
	* `.bytes()` parses the request body as a `Uint8Array`.
	*
	* @see {@link https://hono.dev/docs/api/request#bytes}
	*
	* @example
	* ```ts
	* app.post('/entry', async (c) => {
	*   const body = await c.req.bytes()
	* })
	* ```
	*/
	bytes() {
		return this.#cachedBody("arrayBuffer").then((buffer) => new Uint8Array(buffer));
	}
	/**
	* Parses the request body as a `Blob`.
	* @example
	* ```ts
	* app.post('/entry', async (c) => {
	*   const body = await c.req.blob();
	* });
	* ```
	* @see https://hono.dev/docs/api/request#blob
	*/
	blob() {
		return this.#cachedBody("blob");
	}
	/**
	* Parses the request body as `FormData`.
	* @example
	* ```ts
	* app.post('/entry', async (c) => {
	*   const body = await c.req.formData();
	* });
	* ```
	* @see https://hono.dev/docs/api/request#formdata
	*/
	formData() {
		return this.#cachedBody("formData");
	}
	/**
	* Adds validated data to the request.
	*
	* @param target - The target of the validation.
	* @param data - The validated data to add.
	*/
	addValidatedData(target, data) {
		(this.#validatedData ??= {})[target] = data;
	}
	valid(target) {
		return this.#validatedData?.[target];
	}
	/**
	* `.url` can get the request url strings.
	*
	* @see {@link https://hono.dev/docs/api/request#url}
	*
	* @example
	* ```ts
	* app.get('/about/me', (c) => {
	*   const url = c.req.url // `http://localhost:8787/about/me`
	*   ...
	* })
	* ```
	*/
	get url() {
		return this.raw.url;
	}
	/**
	* `.method` can get the method name of the request.
	*
	* @see {@link https://hono.dev/docs/api/request#method}
	*
	* @example
	* ```ts
	* app.get('/about/me', (c) => {
	*   const method = c.req.method // `GET`
	* })
	* ```
	*/
	get method() {
		return this.raw.method;
	}
	get [GET_MATCH_RESULT]() {
		return this.#matchResult;
	}
	/**
	* `.matchedRoutes` can return a matched route in the handler
	*
	* @deprecated
	*
	* Use matchedRoutes helper defined in "hono/route" instead.
	*
	* @see {@link https://hono.dev/docs/api/request#matchedroutes}
	*
	* @example
	* ```ts
	* app.use('*', async function logger(c, next) {
	*   await next()
	*   c.req.matchedRoutes.forEach(({ handler, method, path }, i) => {
	*     const name = handler.name || (handler.length < 2 ? '[handler]' : '[middleware]')
	*     console.log(
	*       method,
	*       ' ',
	*       path,
	*       ' '.repeat(Math.max(10 - path.length, 0)),
	*       name,
	*       i === c.req.routeIndex ? '<- respond from here' : ''
	*     )
	*   })
	* })
	* ```
	*/
	get matchedRoutes() {
		return this.#matchResult[0].map(([[, route]]) => route);
	}
	/**
	* `.routePath` can retrieve the path registered within the handler
	*
	* @deprecated
	*
	* Use routePath helper defined in "hono/route" instead.
	*
	* @see {@link https://hono.dev/docs/api/request#routepath}
	*
	* @example
	* ```ts
	* app.get('/posts/:id', (c) => {
	*   return c.json({ path: c.req.routePath })
	* })
	* ```
	*/
	get routePath() {
		return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path;
	}
};

//#endregion
//#region hono@4.13.13/dist/utils/html.js
/**
* @module
* HTML utility.
*/
const HtmlEscapedCallbackPhase = {
	Stringify: 1,
	BeforeStream: 2,
	Stream: 3
};
const raw = (value, callbacks) => {
	const escapedString = new String(value);
	escapedString.isEscaped = true;
	escapedString.callbacks = callbacks;
	return escapedString;
};
const resolveCallback = async (str, phase, preserveCallbacks, context, buffer) => {
	if (typeof str === "object" && !(str instanceof String)) {
		if (!(str instanceof Promise)) str = str.toString();
		if (str instanceof Promise) str = await str;
	}
	const callbacks = str.callbacks;
	if (!callbacks?.length) return Promise.resolve(str);
	if (buffer) buffer[0] += str;
	else buffer = [str];
	const resStr = Promise.all(callbacks.map((c) => c({
		phase,
		buffer,
		context
	}))).then((res) => Promise.all(res.filter(Boolean).map((str) => resolveCallback(str, phase, false, context, buffer))).then(() => buffer[0]));
	if (preserveCallbacks) return raw(await resStr, callbacks);
	else return resStr;
};

//#endregion
//#region hono@4.13.13/dist/context.js
const TEXT_PLAIN = "text/plain; charset=UTF-8";
const setDefaultContentType = (contentType, headers) => {
	return {
		"Content-Type": contentType,
		...headers
	};
};
const createResponseInstance = (body, init) => new Response(body, init);
var Context = class {
	#rawRequest;
	#req;
	/**
	* `.env` can get bindings (environment variables, secrets, KV namespaces, D1 database, R2 bucket etc.) in Cloudflare Workers.
	*
	* @see {@link https://hono.dev/docs/api/context#env}
	*
	* @example
	* ```ts
	* // Environment object for Cloudflare Workers
	* app.get('*', async c => {
	*   const counter = c.env.COUNTER
	* })
	* ```
	*/
	env = {};
	#var;
	finalized = false;
	/**
	* `.error` can get the error object from the middleware if the Handler throws an error.
	*
	* @see {@link https://hono.dev/docs/api/context#error}
	*
	* @example
	* ```ts
	* app.use('*', async (c, next) => {
	*   await next()
	*   if (c.error) {
	*     // do something...
	*   }
	* })
	* ```
	*/
	error;
	#status;
	#executionCtx;
	#res;
	#layout;
	#renderer;
	#notFoundHandler;
	#preparedHeaders;
	#matchResult;
	#path;
	/**
	* Creates an instance of the Context class.
	*
	* @param req - The Request object.
	* @param options - Optional configuration options for the context.
	*/
	constructor(req, options) {
		this.#rawRequest = req;
		if (options) {
			this.#executionCtx = options.executionCtx;
			this.env = options.env;
			this.#notFoundHandler = options.notFoundHandler;
			this.#path = options.path;
			this.#matchResult = options.matchResult;
		}
	}
	/**
	* `.req` is the instance of {@link HonoRequest}.
	*/
	get req() {
		this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult);
		return this.#req;
	}
	/**
	* @see {@link https://hono.dev/docs/api/context#event}
	* The FetchEvent associated with the current request.
	*
	* @throws Will throw an error if the context does not have a FetchEvent.
	*/
	get event() {
		if (this.#executionCtx && "respondWith" in this.#executionCtx) return this.#executionCtx;
		else throw Error("This context has no FetchEvent");
	}
	/**
	* @see {@link https://hono.dev/docs/api/context#executionctx}
	* The ExecutionContext associated with the current request.
	*
	* @throws Will throw an error if the context does not have an ExecutionContext.
	*/
	get executionCtx() {
		if (this.#executionCtx) return this.#executionCtx;
		else throw Error("This context has no ExecutionContext");
	}
	/**
	* @see {@link https://hono.dev/docs/api/context#res}
	* The Response object for the current request.
	*/
	get res() {
		return this.#res ||= createResponseInstance(null, { headers: this.#preparedHeaders ??= new Headers() });
	}
	/**
	* Sets the Response object for the current request.
	*
	* @param _res - The Response object to set.
	*/
	set res(_res) {
		if (this.#res && _res) {
			_res = createResponseInstance(_res.body, _res);
			for (const [k, v] of this.#res.headers.entries()) {
				if (k === "content-type") continue;
				if (k === "set-cookie") {
					const cookies = this.#res.headers.getSetCookie();
					_res.headers.delete("set-cookie");
					for (const cookie of cookies) _res.headers.append("set-cookie", cookie);
				} else _res.headers.set(k, v);
			}
		}
		this.#res = _res;
		this.finalized = true;
	}
	/**
	* `.render()` can create a response within a layout.
	*
	* @see {@link https://hono.dev/docs/api/context#render-setrenderer}
	*
	* @example
	* ```ts
	* app.get('/', (c) => {
	*   return c.render('Hello!')
	* })
	* ```
	*/
	render = (...args) => {
		this.#renderer ??= (content) => this.html(content);
		return this.#renderer(...args);
	};
	/**
	* Sets the layout for the response.
	*
	* @param layout - The layout to set.
	* @returns The layout function.
	*/
	setLayout = (layout) => this.#layout = layout;
	/**
	* Gets the current layout for the response.
	*
	* @returns The current layout function.
	*/
	getLayout = () => this.#layout;
	/**
	* `.setRenderer()` can set the layout in the custom middleware.
	*
	* @see {@link https://hono.dev/docs/api/context#render-setrenderer}
	*
	* @example
	* ```tsx
	* app.use('*', async (c, next) => {
	*   c.setRenderer((content) => {
	*     return c.html(
	*       <html>
	*         <body>
	*           <p>{content}</p>
	*         </body>
	*       </html>
	*     )
	*   })
	*   await next()
	* })
	* ```
	*/
	setRenderer = (renderer) => {
		this.#renderer = renderer;
	};
	/**
	* `.header()` can set headers.
	*
	* @see {@link https://hono.dev/docs/api/context#header}
	*
	* @example
	* ```ts
	* app.get('/welcome', (c) => {
	*   // Set headers
	*   c.header('X-Message', 'Hello!')
	*   c.header('Content-Type', 'text/plain')
	*
	*   // Append multiple headers using the append option (e.g. Vary)
	*   c.header('Vary', 'Accept-Encoding', { append: true })
	*   c.header('Vary', 'User-Agent', { append: true })
	*
	*   return c.body('Thank you for coming')
	* })
	* ```
	*/
	header = (name, value, options) => {
		if (this.finalized) this.#res = createResponseInstance(this.#res.body, this.#res);
		const headers = this.#res ? this.#res.headers : this.#preparedHeaders ??= new Headers();
		if (value === void 0) headers.delete(name);
		else if (options?.append) headers.append(name, value);
		else headers.set(name, value);
	};
	status = (status) => {
		this.#status = status;
	};
	/**
	* `.set()` can set the value specified by the key.
	*
	* @see {@link https://hono.dev/docs/api/context#set-get}
	*
	* @example
	* ```ts
	* app.use('*', async (c, next) => {
	*   c.set('message', 'Hono is hot!!')
	*   await next()
	* })
	* ```
	*/
	set = (key, value) => {
		this.#var ??= /* @__PURE__ */ new Map();
		this.#var.set(key, value);
	};
	/**
	* `.get()` can use the value specified by the key.
	*
	* @see {@link https://hono.dev/docs/api/context#set-get}
	*
	* @example
	* ```ts
	* app.get('/', (c) => {
	*   const message = c.get('message')
	*   return c.text(`The message is "${message}"`)
	* })
	* ```
	*/
	get = (key) => {
		return this.#var ? this.#var.get(key) : void 0;
	};
	/**
	* `.var` can access the value of a variable.
	*
	* @see {@link https://hono.dev/docs/api/context#var}
	*
	* @example
	* ```ts
	* const result = c.var.client.oneMethod()
	* ```
	*/
	get var() {
		if (!this.#var) return {};
		return Object.fromEntries(this.#var);
	}
	#newResponse(data, arg, headers) {
		let responseHeaders = this.#res ? new Headers(this.#res.headers) : this.#preparedHeaders;
		if (typeof arg === "object" && arg.headers) {
			responseHeaders ??= new Headers();
			for (const [key, value] of new Headers(arg.headers)) if (key === "set-cookie") responseHeaders.append(key, value);
			else responseHeaders.set(key, value);
		}
		if (headers) {
			if (!responseHeaders) {
				let count = 0;
				for (const k in headers) if (++count > 1 || typeof headers[k] !== "string") {
					responseHeaders = new Headers();
					break;
				}
			}
			if (responseHeaders) for (const k in headers) {
				const v = headers[k];
				if (typeof v === "string") responseHeaders.set(k, v);
				else {
					responseHeaders.delete(k);
					for (const v2 of v) responseHeaders.append(k, v2);
				}
			}
		}
		const status = typeof arg === "number" ? arg : arg?.status ?? this.#status;
		return createResponseInstance(data, {
			status,
			headers: responseHeaders ?? headers
		});
	}
	newResponse = (...args) => this.#newResponse(...args);
	/**
	* `.body()` can return the HTTP response.
	* You can set headers with `.header()` and set HTTP status code with `.status`.
	* This can also be set in `.text()`, `.json()` and so on.
	*
	* @see {@link https://hono.dev/docs/api/context#body}
	*
	* @example
	* ```ts
	* app.get('/welcome', (c) => {
	*   // Set headers
	*   c.header('X-Message', 'Hello!')
	*   c.header('Content-Type', 'text/plain')
	*   // Set HTTP status code
	*   c.status(201)
	*
	*   // Return the response body
	*   return c.body('Thank you for coming')
	* })
	* ```
	*/
	body = (data, arg, headers) => this.#newResponse(data, arg, headers);
	/**
	* `.text()` can render text as `Content-Type:text/plain`.
	*
	* @see {@link https://hono.dev/docs/api/context#text}
	*
	* @example
	* ```ts
	* app.get('/say', (c) => {
	*   return c.text('Hello!')
	* })
	* ```
	*/
	text = (text, arg, headers) => {
		return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized ? new Response(text) : this.#newResponse(text, arg, setDefaultContentType(TEXT_PLAIN, headers));
	};
	/**
	* `.json()` can render JSON as `Content-Type:application/json`.
	*
	* @see {@link https://hono.dev/docs/api/context#json}
	*
	* @example
	* ```ts
	* app.get('/api', (c) => {
	*   return c.json({ message: 'Hello!' })
	* })
	* ```
	*/
	json = (object, arg, headers) => {
		return this.#newResponse(JSON.stringify(object), arg, setDefaultContentType("application/json", headers));
	};
	html = (html, arg, headers) => {
		const res = (html) => this.#newResponse(html, arg, setDefaultContentType("text/html; charset=UTF-8", headers));
		return typeof html === "object" ? resolveCallback(html, HtmlEscapedCallbackPhase.Stringify, false, {}).then(res) : res(html);
	};
	/**
	* `.redirect()` can Redirect, default status code is 302.
	*
	* @see {@link https://hono.dev/docs/api/context#redirect}
	*
	* @example
	* ```ts
	* app.get('/redirect', (c) => {
	*   return c.redirect('/')
	* })
	* app.get('/redirect-permanently', (c) => {
	*   return c.redirect('/', 301)
	* })
	* ```
	*/
	redirect = (location, status) => {
		const locationString = String(location);
		this.header("Location", !/[^\x00-\xFF]/.test(locationString) ? locationString : encodeURI(locationString));
		return this.newResponse(null, status ?? 302);
	};
	/**
	* `.notFound()` can return the Not Found Response.
	*
	* @see {@link https://hono.dev/docs/api/context#notfound}
	*
	* @example
	* ```ts
	* app.get('/notfound', (c) => {
	*   return c.notFound()
	* })
	* ```
	*/
	notFound = () => {
		this.#notFoundHandler ??= () => createResponseInstance();
		return this.#notFoundHandler(this);
	};
};

//#endregion
//#region hono@4.13.13/dist/compose.js
/**
* Compose middleware functions into a single function based on `koa-compose` package.
*
* @template E - The environment type.
*
* @param {[[Function, unknown], unknown][] | [[Function]][]} middleware - An array of middleware functions and their corresponding parameters.
* @param {ErrorHandler<E>} [onError] - An optional error handler function.
* @param {NotFoundHandler<E>} [onNotFound] - An optional not-found handler function.
*
* @returns {(context: Context, next?: Next) => Promise<Context>} - A composed middleware function.
*/
const compose = (middleware, onError, onNotFound) => {
	return (context, next) => {
		let index = -1;
		return dispatch(0);
		/**
		* Dispatch the middleware functions.
		*
		* @param {number} i - The current index in the middleware array.
		*
		* @returns {Promise<Context>} - A promise that resolves to the context.
		*/
		async function dispatch(i) {
			if (i <= index) throw new Error("next() called multiple times");
			index = i;
			let res;
			let isError = false;
			let handler;
			if (middleware[i]) {
				handler = middleware[i][0][0];
				context.req.routeIndex = i;
			} else handler = i === middleware.length && next || void 0;
			if (handler) try {
				res = await handler(context, () => dispatch(i + 1));
			} catch (err) {
				if (err instanceof Error && onError) {
					context.error = err;
					res = await onError(err, context);
					isError = true;
				} else throw err;
			}
			else if (context.finalized === false && onNotFound) res = await onNotFound(context);
			if (res && (context.finalized === false || isError)) context.res = res;
			return context;
		}
	};
};

//#endregion
//#region hono@4.13.13/dist/router.js
/**
* Array of supported HTTP methods.
*/
const METHODS = [
	"get",
	"post",
	"put",
	"delete",
	"options",
	"patch",
	"query"
];
/**
* Error message indicating that a route cannot be added because the matcher is already built.
*/
const MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.";
/**
* Error class representing an unsupported path error.
*/
var UnsupportedPathError = class extends Error {};

//#endregion
//#region hono@4.13.13/dist/utils/constants.js
/**
* Constant used to mark a composed handler.
*/
const COMPOSED_HANDLER = "__COMPOSED_HANDLER";

//#endregion
//#region hono@4.13.13/dist/hono-base.js
/**
* @module
* This module is the base module for the Hono object.
*/
const notFoundHandler = (c) => {
	return c.text("404 Not Found", 404);
};
const errorHandler = (err, c) => {
	if ("getResponse" in err) {
		const res = err.getResponse();
		return c.newResponse(res.body, res);
	}
	console.error(err);
	return c.text("Internal Server Error", 500);
};
var Hono$1 = class Hono {
	get;
	post;
	put;
	delete;
	options;
	patch;
	query;
	all;
	on;
	use;
	router;
	getPath;
	_basePath = "/";
	#path = "/";
	routes = [];
	constructor(options = {}) {
		[...METHODS, "all"].forEach((method) => {
			this[method] = (args1, ...args) => {
				const methodName = method.toUpperCase();
				if (typeof args1 === "string") this.#path = args1;
				else this.#addRoute(methodName, this.#path, args1);
				args.forEach((handler) => {
					this.#addRoute(methodName, this.#path, handler);
				});
				return this;
			};
		});
		this.on = (method, path, ...handlers) => {
			for (const p of [path].flat()) {
				this.#path = p;
				for (const m of [method].flat()) {
					const methodName = m.toUpperCase();
					for (const handler of handlers) this.#addRoute(methodName, this.#path, handler);
				}
			}
			return this;
		};
		this.use = (arg1, ...handlers) => {
			if (typeof arg1 === "string") this.#path = arg1;
			else {
				this.#path = "*";
				handlers.unshift(arg1);
			}
			handlers.forEach((handler) => {
				this.#addRoute("ALL", this.#path, handler);
			});
			return this;
		};
		const { strict, ...optionsWithoutStrict } = options;
		Object.assign(this, optionsWithoutStrict);
		this.getPath = strict ?? true ? options.getPath ?? getPath : getPathNoStrict;
	}
	#clone() {
		const clone = new Hono({
			router: this.router,
			getPath: this.getPath
		});
		clone.errorHandler = this.errorHandler;
		clone.#notFoundHandler = this.#notFoundHandler;
		clone.routes = this.routes;
		return clone;
	}
	#notFoundHandler = notFoundHandler;
	errorHandler = errorHandler;
	/**
	* `.route()` allows grouping other Hono instance in routes.
	*
	* @see {@link https://hono.dev/docs/api/routing#grouping}
	*
	* @param {string} path - base Path
	* @param {Hono} app - other Hono instance
	* @returns {Hono} routed Hono instance
	*
	* @example
	* ```ts
	* const app = new Hono()
	* const app2 = new Hono()
	*
	* app2.get("/user", (c) => c.text("user"))
	* app.route("/api", app2) // GET /api/user
	* ```
	*/
	route(path, app) {
		const subApp = this.basePath(path);
		app.routes.map((r) => {
			let handler;
			if (app.errorHandler === errorHandler) handler = r.handler;
			else {
				handler = async (c, next) => (await compose([], app.errorHandler)(c, () => r.handler(c, next))).res;
				handler[COMPOSED_HANDLER] = r.handler;
			}
			subApp.#addRoute(r.method, r.path, handler, r.basePath);
		});
		return this;
	}
	/**
	* `.basePath()` allows base paths to be specified.
	*
	* @see {@link https://hono.dev/docs/api/routing#base-path}
	*
	* @param {string} path - base Path
	* @returns {Hono} changed Hono instance
	*
	* @example
	* ```ts
	* const api = new Hono().basePath('/api')
	* ```
	*/
	basePath(path) {
		const subApp = this.#clone();
		subApp._basePath = mergePath(this._basePath, path);
		return subApp;
	}
	/**
	* `.onError()` handles an error and returns a customized Response.
	*
	* @see {@link https://hono.dev/docs/api/hono#error-handling}
	*
	* @param {ErrorHandler} handler - request Handler for error
	* @returns {Hono} changed Hono instance
	*
	* @example
	* ```ts
	* app.onError((err, c) => {
	*   console.error(`${err}`)
	*   return c.text('Custom Error Message', 500)
	* })
	* ```
	*/
	onError = (handler) => {
		this.errorHandler = handler;
		return this;
	};
	/**
	* `.notFound()` allows you to customize a Not Found Response.
	*
	* @see {@link https://hono.dev/docs/api/hono#not-found}
	*
	* @param {NotFoundHandler} handler - request handler for not-found
	* @returns {Hono} changed Hono instance
	*
	* @example
	* ```ts
	* app.notFound((c) => {
	*   return c.text('Custom 404 Message', 404)
	* })
	* ```
	*/
	notFound = (handler) => {
		this.#notFoundHandler = handler;
		return this;
	};
	/**
	* `.mount()` allows you to mount applications built with other frameworks into your Hono application.
	*
	* @deprecated Use `mount()` from `hono/mount` instead. `.mount()` will be removed in v5.
	*
	* @see {@link https://hono.dev/docs/api/hono#mount}
	*
	* @param {string} path - base Path
	* @param {Function} applicationHandler - other Request Handler
	* @param {MountOptions} [options] - options of `.mount()`
	* @returns {Hono} mounted Hono instance
	*
	* @example
	* ```ts
	* import { Router as IttyRouter } from 'itty-router'
	* import { Hono } from 'hono'
	* // Create itty-router application
	* const ittyRouter = IttyRouter()
	* // GET /itty-router/hello
	* ittyRouter.get('/hello', () => new Response('Hello from itty-router'))
	*
	* const app = new Hono()
	* app.mount('/itty-router', ittyRouter.handle)
	* ```
	*
	* @example
	* ```ts
	* const app = new Hono()
	* // Send the request to another application without modification.
	* app.mount('/app', anotherApp, {
	*   replaceRequest: (req) => req,
	* })
	* ```
	*/
	mount(path, applicationHandler, options) {
		let replaceRequest;
		let optionHandler;
		if (options) {
			if (typeof options === "function") optionHandler = options;
			else {
				optionHandler = options.optionHandler;
				if (options.replaceRequest === false) replaceRequest = (request) => request;
				else replaceRequest = options.replaceRequest;
			}
		}
		const getOptions = optionHandler ? (c) => {
			const options = optionHandler(c);
			return Array.isArray(options) ? options : [options];
		} : (c) => {
			let executionContext = void 0;
			try {
				executionContext = c.executionCtx;
			} catch {}
			return [c.env, executionContext];
		};
		replaceRequest ||= (() => {
			const mergedPath = mergePath(this._basePath, path);
			const pathPrefixLength = mergedPath === "/" ? 0 : mergedPath.length;
			return (request) => {
				const url = new URL(request.url);
				url.pathname = this.getPath(request).slice(pathPrefixLength) || "/";
				return new Request(url, request);
			};
		})();
		const handler = async (c, next) => {
			const res = await applicationHandler(replaceRequest(c.req.raw), ...getOptions(c));
			if (res) return res;
			await next();
		};
		this.#addRoute("ALL", mergePath(path, "*"), handler);
		return this;
	}
	#addRoute(method, path, handler, baseRoutePath) {
		path = mergePath(this._basePath, path);
		const r = {
			basePath: baseRoutePath !== void 0 ? mergePath(this._basePath, baseRoutePath) : this._basePath,
			path,
			method,
			handler
		};
		this.router.add(method, path, [handler, r]);
		this.routes.push(r);
	}
	#handleError(err, c) {
		if (err instanceof Error) return this.errorHandler(err, c);
		throw err;
	}
	#dispatch(request, executionCtx, env, method) {
		if (method === "HEAD") return (async () => new Response(null, await this.#dispatch(request, executionCtx, env, "GET")))();
		const path = this.getPath(request, { env });
		const matchResult = this.router.match(method, path);
		const c = new Context(request, {
			path,
			matchResult,
			env,
			executionCtx,
			notFoundHandler: this.#notFoundHandler
		});
		if (matchResult[0].length === 1) {
			let res;
			try {
				res = matchResult[0][0][0][0](c, async () => {
					c.res = await this.#notFoundHandler(c);
				});
			} catch (err) {
				return this.#handleError(err, c);
			}
			return res instanceof Promise ? res.then((resolved) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c))).catch((err) => this.#handleError(err, c)) : res ?? this.#notFoundHandler(c);
		}
		const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler);
		return (async () => {
			try {
				const context = await composed(c);
				if (!context.finalized) throw new Error("Context is not finalized. Did you forget to return a Response object or `await next()`?");
				return context.res;
			} catch (err) {
				return this.#handleError(err, c);
			}
		})();
	}
	/**
	* `.fetch()` will be entry point of your app.
	*
	* @see {@link https://hono.dev/docs/api/hono#fetch}
	*
	* @param {Request} request - request Object of request
	* @param {Env} env - env Object
	* @param {ExecutionContext} executionCtx - context of execution
	* @returns {Response | Promise<Response>} response of request
	*
	*/
	fetch = (request, ...rest) => {
		return this.#dispatch(request, rest[1], rest[0], request.method);
	};
	/**
	* `.request()` is a useful method for testing.
	* You can pass a URL or pathname to send a GET request.
	* app will return a Response object.
	* ```ts
	* test('GET /hello is ok', async () => {
	*   const res = await app.request('/hello')
	*   expect(res.status).toBe(200)
	* })
	* ```
	* @see https://hono.dev/docs/api/hono#request
	*/
	request = (input, requestInit, Env, executionCtx) => {
		if (input instanceof Request) return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
		input = input.toString();
		return this.fetch(new Request(/^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`, requestInit), Env, executionCtx);
	};
	/**
	* `.fire()` automatically adds a global fetch event listener.
	* This can be useful for environments that adhere to the Service Worker API, such as non-ES module Cloudflare Workers.
	* @deprecated
	* Use `fire` from `hono/service-worker` instead.
	* ```ts
	* import { Hono } from 'hono'
	* import { fire } from 'hono/service-worker'
	*
	* const app = new Hono()
	* // ...
	* fire(app)
	* ```
	* @see https://hono.dev/docs/api/hono#fire
	* @see https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
	* @see https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/
	*/
	fire = () => {
		addEventListener("fetch", (event) => {
			event.respondWith(this.#dispatch(event.request, event, void 0, event.request.method));
		});
	};
};

//#endregion
//#region hono@4.13.13/dist/router/utils.js
const createNullObject = () => Object.create(null);

//#endregion
//#region hono@4.13.13/dist/router/reg-exp-router/matcher.js
const emptyParam = [];
function match(method, path) {
	const matchers = this.buildAllMatchers();
	const match = ((method, path) => {
		const matcher = matchers[method] || matchers["ALL"];
		const staticMatch = matcher[2][path];
		if (staticMatch) return staticMatch;
		const match = path.match(matcher[0]);
		if (!match) return [[], emptyParam];
		const index = match.indexOf("", 1);
		return [matcher[1][index], match];
	});
	this.match = match;
	return match(method, path);
}

//#endregion
//#region hono@4.13.13/dist/router/reg-exp-router/node.js
const LABEL_REG_EXP_STR = "[^/]+";
const TAIL_WILDCARD_REG_EXP_STR = "(?:|/.*)";
const PATH_ERROR = Symbol();
const regExpMetaChars = /* @__PURE__ */ new Set(".\\+*[^]$()");
/**
* Sort order:
* 1. literal
* 2. special pattern (e.g. :label{[0-9]+})
* 3. common label pattern (e.g. :label)
* 4. wildcard
*/
function compareKey(a, b) {
	if (a.length === 1) return b.length === 1 ? a < b ? -1 : 1 : -1;
	if (b.length === 1) return 1;
	if (a === ".*" || a === "(?:|/.*)") return b === "(?:|/.*)" ? -1 : 1;
	else if (b === ".*" || b === "(?:|/.*)") return -1;
	if (a === "[^/]+") return 1;
	else if (b === "[^/]+") return -1;
	return a.length === b.length ? a < b ? -1 : 1 : b.length - a.length;
}
var Node$1 = class Node {
	#index;
	#varIndex;
	#children = createNullObject();
	insert(tokens, index, paramMap, context, isStatic) {
		let node = this;
		for (let i = 0, len = tokens.length; i < len; i++) {
			const token = tokens[i];
			const pattern = token.length === 1 ? token === "*" ? i === len - 1 ? [
				"",
				"",
				".*"
			] : [
				"",
				"",
				LABEL_REG_EXP_STR
			] : null : token === "/*" ? [
				"",
				"",
				TAIL_WILDCARD_REG_EXP_STR
			] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
			let nextNode;
			if (pattern) {
				const name = pattern[1];
				let regexpStr = pattern[2] || "[^/]+";
				if (name && pattern[2]) {
					if (regexpStr === ".*") throw PATH_ERROR;
					regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
					if (/\((?!\?:)/.test(regexpStr)) throw PATH_ERROR;
					if (regexpStr.length === 1 && regExpMetaChars.has(regexpStr)) throw PATH_ERROR;
				}
				nextNode = node.#children[regexpStr];
				if (!nextNode) {
					if (regexpStr !== ".*" && regexpStr !== "(?:|/.*)") {
						for (const k in node.#children) if ((regexpStr.length > 1 || k.length > 1) && k !== ".*" && k !== "(?:|/.*)") throw PATH_ERROR;
					}
					nextNode = node.#children[regexpStr] = new Node();
				}
				if (name !== "") {
					nextNode.#varIndex ??= context.varIndex++;
					paramMap.push([name, nextNode.#varIndex]);
				}
			} else {
				nextNode = node.#children[token];
				if (!nextNode) {
					for (const k in node.#children) if (k.length > 1 && k !== ".*" && k !== "(?:|/.*)") throw PATH_ERROR;
					nextNode = node.#children[token] = new Node();
				}
			}
			node = nextNode;
		}
		if (node.#index !== void 0) throw PATH_ERROR;
		node.#index = isStatic ? -1 : index;
	}
	buildRegExpStr() {
		const strList = Object.keys(this.#children).sort(compareKey).map((k) => {
			const c = this.#children[k];
			const childStr = c.buildRegExpStr();
			return childStr === "" ? "" : (typeof c.#varIndex === "number" ? `(${k})@${c.#varIndex}` : regExpMetaChars.has(k) ? `\\${k}` : k) + childStr;
		}).filter(Boolean);
		if (typeof this.#index === "number" && this.#index !== -1) strList.unshift(`#${this.#index}`);
		if (strList.length === 0) return "";
		if (strList.length === 1) return strList[0];
		return "(?:" + strList.join("|") + ")";
	}
};

//#endregion
//#region hono@4.13.13/dist/router/reg-exp-router/trie.js
var Trie = class {
	#context = { varIndex: 0 };
	#root = new Node$1();
	#index = 0;
	paths = createNullObject();
	insert(path, isStatic) {
		if (isStatic) {
			this.#root.insert(path.split(""), 0, [], this.#context, true);
			return;
		}
		const paramAssoc = [];
		const groups = [];
		let markedPath = path;
		for (let i = 0;;) {
			let replaced = false;
			markedPath = markedPath.replace(/\{[^}]+\}/g, (m) => {
				const mark = `@\\${i}`;
				groups[i] = [mark, m];
				i++;
				replaced = true;
				return mark;
			});
			if (!replaced) break;
		}
		/**
		*  - pattern (:label, :label{0-9]+}, ...)
		*  - /* wildcard
		*  - character
		*/
		const tokens = markedPath.match(/(?::[^\/]+)|(?:\/\*$)|./g) || [];
		for (let i = groups.length - 1; i >= 0; i--) {
			const [mark] = groups[i];
			for (let j = tokens.length - 1; j >= 0; j--) if (tokens[j].indexOf(mark) !== -1) {
				tokens[j] = tokens[j].replace(mark, groups[i][1]);
				break;
			}
		}
		this.#root.insert(tokens, this.#index, paramAssoc, this.#context, false);
		this.paths[path] = [this.#index++, paramAssoc];
	}
	buildRegExp() {
		let regexp = this.#root.buildRegExpStr();
		if (regexp === "") return [
			/^$/,
			[],
			[]
		];
		let captureIndex = 0;
		const indexReplacementMap = [];
		const paramReplacementMap = [];
		regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
			if (handlerIndex !== void 0) {
				indexReplacementMap[++captureIndex] = Number(handlerIndex);
				return "$()";
			}
			if (paramIndex !== void 0) {
				paramReplacementMap[Number(paramIndex)] = ++captureIndex;
				return "";
			}
			return "";
		});
		return [
			new RegExp(`^${regexp}`),
			indexReplacementMap,
			paramReplacementMap
		];
	}
};

//#endregion
//#region hono@4.13.13/dist/router/reg-exp-router/router.js
let wildcardRegExpCache = createNullObject();
function buildWildcardRegExp(path) {
	return wildcardRegExpCache[path] ??= new RegExp(`^${path.replace(/\/:[^/{}]+(?:\{\[\^\/]\+})?(?=[/{]|$)|\/?\*$|([.\\+*[^\]$()?{}|])/g, (match, metaChar) => metaChar ? `\\${metaChar}` : match === "/*" ? TAIL_WILDCARD_REG_EXP_STR : match === "*" ? ".*" : `/:${LABEL_REG_EXP_STR}`)}$`);
}
function findMiddleware(middleware, path) {
	for (const k of Object.keys(middleware).sort((a, b) => b.length - a.length)) if (buildWildcardRegExp(k).test(path)) return [...middleware[k]];
}
var RegExpRouter = class {
	name = "RegExpRouter";
	#middleware;
	#routes;
	#tries;
	constructor() {
		this.#middleware = { ["ALL"]: createNullObject() };
		this.#routes = { ["ALL"]: createNullObject() };
		this.#tries = { ["ALL"]: new Trie() };
	}
	#insertPath(method, path) {
		try {
			this.#tries[method].insert(path, !/\*|\/:/.test(path));
		} catch (e) {
			throw e === PATH_ERROR ? new UnsupportedPathError(path) : e;
		}
	}
	add(method, path, handler) {
		const middleware = this.#middleware;
		const routes = this.#routes;
		if (!middleware) throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
		if (!middleware[method]) {
			this.#tries[method] = new Trie();
			for (const handlerMap of [middleware, routes]) {
				handlerMap[method] = createNullObject();
				for (const p in handlerMap["ALL"]) {
					handlerMap[method][p] = [...handlerMap["ALL"][p]];
					this.#insertPath(method, p);
				}
			}
		}
		if (path === "/*") path = "*";
		const methods = method === "ALL" ? Object.keys(middleware) : [method];
		if (/\*$/.test(path)) {
			const re = buildWildcardRegExp(path);
			for (const m of methods) if (!middleware[m][path]) {
				this.#insertPath(m, path);
				middleware[m][path] = findMiddleware(middleware[m], path) || findMiddleware(middleware["ALL"], path) || [];
			}
			for (const handlerMap of [middleware, routes]) for (const m of methods) for (const p in handlerMap[m]) re.test(p) && handlerMap[m][p].push([handler, path]);
			return;
		}
		const paths = checkOptionalParameter(path) || [path];
		for (const path of paths) for (const m of methods) {
			if (!routes[m][path]) {
				this.#insertPath(m, path);
				routes[m][path] = findMiddleware(middleware[m], path) || findMiddleware(middleware["ALL"], path) || [];
			}
			routes[m][path].push([handler, path]);
		}
	}
	match = match;
	buildAllMatchers() {
		const matchers = createNullObject();
		for (const method of Object.keys(this.#routes)) matchers[method] = this.#buildMatcher(method);
		this.#middleware = this.#routes = this.#tries = void 0;
		wildcardRegExpCache = createNullObject();
		return matchers;
	}
	#buildMatcher(method) {
		const middleware = this.#middleware[method];
		const routes = this.#routes[method];
		const trie = this.#tries[method];
		const staticMap = createNullObject();
		const handlerData = [];
		const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp();
		for (const r of [middleware, routes]) for (const path in r) {
			const handlers = r[path];
			const pathData = trie.paths[path];
			if (!pathData) {
				staticMap[path] = [handlers.map(([h]) => [h, createNullObject()]), emptyParam];
				continue;
			}
			handlerData[pathData[0]] = handlers.map(([h, handlerPath]) => [h, trie.paths[handlerPath][1].reduceRight((map, [key], i) => {
				map[key] = paramReplacementMap[pathData[1][i][1]];
				return map;
			}, createNullObject())]);
		}
		return [
			regexp,
			indexReplacementMap.map((i) => handlerData[i]),
			staticMap
		];
	}
};

//#endregion
//#region hono@4.13.13/dist/router/smart-router/router.js
var SmartRouter = class {
	name = "SmartRouter";
	#routers = [];
	#routes = [];
	constructor(init) {
		this.#routers = init.routers;
	}
	add(method, path, handler) {
		if (!this.#routes) throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
		this.#routes.push([
			method,
			path,
			handler
		]);
	}
	match(method, path) {
		if (!this.#routes) throw new Error("Fatal error");
		const routers = this.#routers;
		const routes = this.#routes;
		const len = routers.length;
		let i = 0;
		let res;
		for (; i < len; i++) {
			const router = routers[i];
			try {
				for (let i = 0, len = routes.length; i < len; i++) router.add(...routes[i]);
				res = router.match(method, path);
			} catch (e) {
				if (e instanceof UnsupportedPathError) continue;
				throw e;
			}
			this.match = router.match.bind(router);
			this.#routers = [router];
			this.#routes = void 0;
			break;
		}
		if (i === len) throw new Error("Fatal error");
		this.name = `SmartRouter + ${this.activeRouter.name}`;
		return res;
	}
	get activeRouter() {
		if (this.#routes || this.#routers.length !== 1) throw new Error("No active router has been determined yet.");
		return this.#routers[0];
	}
};

//#endregion
//#region hono@4.13.13/dist/router/trie-router/node.js
const emptyParams = createNullObject();
let order = 0;
var Node = class Node {
	#methods = [];
	#children = createNullObject();
	#patterns = [];
	#pattern;
	#params = emptyParams;
	insert(method, path, handler) {
		let curNode = this;
		const parts = splitRoutingPath(path);
		const possibleKeys = /* @__PURE__ */ new Set();
		let i = 0;
		for (const p of parts) {
			const nextP = parts[++i];
			const pattern = getPattern(p, nextP) || (nextP === void 0 && p && p.indexOf("*") === p.length - 1 ? p : null);
			const isParam = Array.isArray(pattern);
			const key = isParam ? pattern[0] : pattern || p;
			const child = curNode.#children[key] ||= new Node();
			if (pattern && !child.#pattern) {
				child.#pattern = pattern;
				curNode.#patterns.push(child);
			}
			curNode = child;
			if (isParam) possibleKeys.add(pattern[1]);
		}
		curNode.#methods.push({ [method]: {
			handler,
			possibleKeys: [...possibleKeys],
			score: ++order
		} });
	}
	#pushHandlerSets(handlerSets, node, method, nodeParams, params) {
		for (let i = 0, len = node.#methods.length; i < len; i++) {
			const m = node.#methods[i];
			const handlerSet = m[method] || m["ALL"];
			if (handlerSet) {
				handlerSet.params = createNullObject();
				handlerSets.push(handlerSet);
				for (let i = 0, len = handlerSet.possibleKeys.length; i < len; i++) {
					const key = handlerSet.possibleKeys[i];
					handlerSet.params[key] = params?.[key] && !i ? params[key] : nodeParams[key] ?? params?.[key];
				}
			}
		}
	}
	search(method, path) {
		const handlerSets = [];
		this.#params = emptyParams;
		let curNodes = [this];
		const parts = splitPath(path);
		const curNodesQueue = [];
		const len = parts.length;
		let partOffsets = null;
		for (let i = 0; i < len; i++) {
			const part = parts[i];
			const isLast = i === len - 1;
			const tempNodes = [];
			for (let j = 0, len2 = curNodes.length; j < len2; j++) {
				const node = curNodes[j];
				const nextNode = node.#children[part];
				if (nextNode) {
					nextNode.#params = node.#params;
					if (isLast) {
						if (nextNode.#children["*"]) this.#pushHandlerSets(handlerSets, nextNode.#children["*"], method, node.#params);
						this.#pushHandlerSets(handlerSets, nextNode, method, node.#params);
					} else tempNodes.push(nextNode);
				}
				for (const child of node.#patterns) {
					const pattern = child.#pattern;
					const params = node.#params === emptyParams ? {} : { ...node.#params };
					if (typeof pattern === "string") {
						if (pattern === "*" || part.startsWith(pattern.slice(0, -1))) {
							this.#pushHandlerSets(handlerSets, child, method, node.#params);
							if (pattern === "*") {
								child.#params = params;
								tempNodes.push(child);
							}
						}
						continue;
					}
					const [, name, matcher] = pattern;
					if (!part && matcher === true) continue;
					if (matcher !== true) {
						if (!partOffsets) {
							partOffsets = [];
							let offset = path[0] === "/" ? 1 : 0;
							for (let p = 0; p < len; p++) {
								partOffsets[p] = offset;
								offset += parts[p].length + 1;
							}
						}
						const restPathString = path.slice(partOffsets[i]);
						const m = matcher.exec(restPathString);
						if (m) {
							params[name] = m[0];
							this.#pushHandlerSets(handlerSets, child, method, node.#params, params);
							if (m[0].length === restPathString.length && child.#children["*"]) this.#pushHandlerSets(handlerSets, child.#children["*"], method, node.#params, params);
							for (const _ in child.#children) {
								child.#params = params;
								const componentCount = m[0].match(/\//g)?.length ?? 0;
								(curNodesQueue[componentCount] ||= []).push(child);
								break;
							}
							continue;
						}
					}
					if (matcher === true || matcher.test(part)) {
						params[name] = part;
						if (isLast) {
							this.#pushHandlerSets(handlerSets, child, method, params, node.#params);
							if (child.#children["*"]) this.#pushHandlerSets(handlerSets, child.#children["*"], method, params, node.#params);
						} else {
							child.#params = params;
							tempNodes.push(child);
						}
					}
				}
			}
			const shifted = curNodesQueue.shift();
			curNodes = shifted ? tempNodes.concat(shifted) : tempNodes;
		}
		if (handlerSets[1]) handlerSets.sort((a, b) => {
			return a.score - b.score;
		});
		return [handlerSets.map(({ handler, params }) => [handler, params])];
	}
};

//#endregion
//#region hono@4.13.13/dist/router/trie-router/router.js
var TrieRouter = class {
	name = "TrieRouter";
	#node = new Node();
	add(method, path, handler) {
		for (const result of checkOptionalParameter(path) || [path]) this.#node.insert(method, result, handler);
	}
	match(method, path) {
		return this.#node.search(method, path);
	}
};

//#endregion
//#region hono@4.13.13/dist/hono.js
/**
* The Hono class extends the functionality of the HonoBase class.
* It sets up routing and allows for custom options to be passed.
*
* @template E - The environment type.
* @template S - The schema type.
* @template BasePath - The base path type.
*/
var Hono = class extends Hono$1 {
	/**
	* Creates an instance of the Hono class.
	*
	* @param options - Optional configuration options for the Hono instance.
	*/
	constructor(options = {}) {
		super(options);
		this.router = options.router ?? new SmartRouter({ routers: [new RegExpRouter(), new TrieRouter()] });
	}
};

//#endregion
//#region hono@4.13.13/dist/helper/route/index.js
/**
* Get matched routes in the handler
*
* @param {Context} c - The context object
* @returns An array of matched routes
*
* @example
* ```ts
* import { matchedRoutes } from 'hono/route'
*
* app.use('*', async function logger(c, next) {
*   await next()
*   matchedRoutes(c).forEach(({ handler, method, path }, i) => {
*     const name = handler.name || (handler.length < 2 ? '[handler]' : '[middleware]')
*     console.log(
*       method,
*       ' ',
*       path,
*       ' '.repeat(Math.max(10 - path.length, 0)),
*       name,
*       i === c.req.routeIndex ? '<- respond from here' : ''
*     )
*   })
* })
* ```
*/
const matchedRoutes = (c) => c.req[GET_MATCH_RESULT][0].map(([[, route]]) => route);
/**
* Get the route path registered within the handler
*
* @param {Context} c - The context object
* @param {number} index - The index of the route from which to retrieve the path, similar to Array.prototype.at(), where a negative number is the index counted from the end of the matching route. Defaults to the current route index.
* @returns The route path registered within the handler
*
* @example
* ```ts
* import { routePath } from 'hono/route'
*
* app.use('*', (c, next) => {
*   console.log(routePath(c)) // '*'
*   console.log(routePath(c, -1)) // '/posts/:id'
*   return next()
* })
*
* app.get('/posts/:id', (c) => {
*   return c.text(routePath(c)) // '/posts/:id'
* })
* ```
*/
const routePath = (c, index) => matchedRoutes(c).at(index ?? c.req.routeIndex)?.path ?? "";

//#endregion
//#region apps/api/src/routes/ai.ts
const aiHandlers = {};

//#endregion
//#region apps/api/src/routes/check.ts
const checkHandlers = {};

//#endregion
//#region apps/api/src/routes/desk.ts
const deskHandlers = {};

//#endregion
//#region apps/api/src/routes/health.ts
/**
* `GET /v1/health` (public, docs/paypal/SPEC.md §13, §14.2 F8): one row per dependency for the Status page, from public
* facts only: which secrets and bindings are present (never their values), what the Global store last saw (P5, verified
* webhook, cron), and the chain's deployment as the registry records it. A row whose fact cannot be read says `unknown`;
* a read never fails the document. Cached per isolate for 5 seconds.
*
* Owner: foundation (the document); each workstream sharpens its own row through the Global store's `noteHealth`.
*/
const CACHE_MS = 5e3;
const READ_TIMEOUT_MS = 2e3;
async function readFacts(services) {
	let timer;
	try {
		return await Promise.race([services.stores.global().readHealth(), new Promise((resolve) => {
			timer = setTimeout(() => {
				resolve(null);
			}, READ_TIMEOUT_MS);
		})]);
	} catch {
		return null;
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
const iso = (ms) => ms === void 0 ? null : new Date(ms).toISOString();
/** The rows, from the runtime's configuration and the store's facts (`null`: the store could not be read). */
function healthRows(services, facts, now) {
	const { config, secrets } = services.runtime;
	const paypalConfigured = config.paypal.mode === "fake" || secrets.paypalClientId !== void 0 && secrets.paypalClientSecret !== void 0;
	const lastGet = facts?.["paypal-get"]?.at;
	const lastWebhook = facts?.["webhook-verified"]?.at;
	const backoff = facts?.["paypal-backoff"];
	return [
		{
			id: "paypal",
			state: !paypalConfigured ? "not-configured" : backoff !== void 0 && (backoff.value ?? 0) > 0 ? "degraded" : lastGet === void 0 ? "unknown" : "ok",
			code: !paypalConfigured ? "credentials-missing" : config.paypal.mode === "fake" ? "fake" : lastGet === void 0 ? "not-read-yet" : "last-get",
			checkedAt: iso(lastGet)
		},
		{
			id: "webhook",
			state: config.paypal.mode === "fake" ? "ok" : secrets.paypalWebhookId === void 0 ? "not-configured" : lastWebhook === void 0 ? "unknown" : "ok",
			code: secrets.paypalWebhookId === void 0 && config.paypal.mode !== "fake" ? "webhook-id-missing" : lastWebhook === void 0 ? "none-verified-yet" : "last-verified",
			checkedAt: iso(lastWebhook),
			...lastWebhook === void 0 ? {} : { values: { ageSeconds: Math.max(0, Math.round((now - lastWebhook) / 1e3)) } }
		},
		{
			id: "assistant",
			state: config.ai.mode === "disabled" ? "not-configured" : services.ai.kind === config.ai.mode ? "unknown" : "degraded",
			code: config.ai.mode === "disabled" ? "disabled" : `model:${services.ai.model}`,
			checkedAt: null,
			values: { dailyNeuronBudget: config.ai.dailyNeuronBudget }
		},
		{
			id: "chain",
			state: services.chain.deployed ? "ok" : "degraded",
			code: services.chain.deployed ? "deployed" : "not-deployed",
			checkedAt: null,
			values: { chainId: services.chain.chainId }
		},
		{
			id: "store",
			state: facts === null ? "unknown" : "ok",
			code: facts === null ? "unreadable" : "readable",
			checkedAt: iso(facts?.["cron-run"]?.at)
		}
	];
}
function healthDocument(services, rows, now) {
	return {
		status: rows.some((r) => r.state === "down") ? "down" : rows.every((r) => r.state === "ok") ? "ok" : "degraded",
		service: "paylink-api",
		version: services.runtime.config.version,
		contract: 1,
		time: new Date(now).toISOString(),
		paypalEnvironment: "sandbox",
		rows
	};
}
let cached = null;
const healthHandlers = { health: async ({ c, services, now }) => {
	if (cached?.services !== services || now - cached.at >= CACHE_MS) cached = {
		at: now,
		services,
		doc: healthDocument(services, healthRows(services, await readFacts(services), now), now)
	};
	c.header("Cache-Control", "no-store");
	return c.json(cached.doc, 200);
} };

//#endregion
//#region apps/api/src/routes/session.ts
const sessionHandlers = {};

//#endregion
//#region apps/api/src/routes/twin.ts
const twinHandlers = {};

//#endregion
//#region apps/api/src/routes/types.ts
/** Largest accepted request body per route (bytes); 8 KiB unless listed. The webhook's cap is §7.5's 64 KB. */
const BODY_LIMITS = {
	"paypal.webhook": 65536,
	"ai.draft": 16384,
	check: 16384
};
const DEFAULT_BODY_LIMIT = 8192;

//#endregion
//#region apps/api/src/routes/webhook.ts
const webhookHandlers = {};

//#endregion
//#region apps/api/src/core/log.ts
const LEVELS = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40
};
/** Field names that can only carry secrets, tokens, signatures or user text: dropped whatever their value. */
const FORBIDDEN_FIELD = /(?:secret|token|password|authorization|cookie|signature|^sig$|hmac|body|prompt|message|text|email|header)/iu;
function scrubber(secrets) {
	const needles = [...new Set(secrets.filter((s) => s !== void 0 && s.length >= 12))];
	return (line) => needles.reduce((out, needle) => out.split(needle).join("[redacted]"), line);
}
function createLogger(options) {
	const scrub = scrubber(options.secrets ?? []);
	const min = LEVELS[options.minLevel ?? "info"];
	const now = options.now ?? Date.now;
	const make = (base) => ({
		log(level, event, fields = {}) {
			if (LEVELS[level] < min) return;
			const kept = {};
			for (const [name, value] of Object.entries({
				...base,
				...fields
			})) if (value !== void 0 && !FORBIDDEN_FIELD.test(name)) kept[name] = value;
			options.sink(scrub(JSON.stringify({
				ts: new Date(now()).toISOString(),
				level,
				event,
				...kept
			})));
		},
		child(fields) {
			return make({
				...base,
				...fields
			});
		}
	});
	return make(options.base ?? {});
}
/** An error reduced to what may be logged: its class name and, for PayPal errors, status and code (never a body). */
function errorFields(error) {
	if (error instanceof Error) {
		const status = error.status;
		const paypalName = error.paypalName;
		return {
			errorName: error.name,
			...typeof status === "number" ? { status } : {},
			...typeof paypalName === "string" ? { paypalName } : {}
		};
	}
	return { errorName: typeof error };
}

//#endregion
//#region apps/api/src/core/problem.ts
/**
* RFC 9457 problem responses with the contract's stable codes (`API_PROBLEMS` in @paylink/api-contract). Clients branch
* on `code` and `rule`, never on `detail`.
*
* Owner: foundation.
*/
function problem(code, detail, extensions = {}) {
	const { status, title } = API_PROBLEMS[code];
	return {
		type: problemType(code),
		code,
		status,
		title,
		detail,
		...extensions
	};
}
/** The documentation URI of a problem code (RFC 9457 `type`). */
function problemType(code) {
	return `https://github.com/nambininasafidison/paylink/blob/paypal/apps/api/README.md#problem-${code}`;
}
/** A thrown problem: route handlers throw it, the app turns it into the response. */
var ProblemError = class extends Error {
	problem;
	constructor(code, detail, extensions = {}) {
		super(detail);
		this.name = "ProblemError";
		this.problem = problem(code, detail, extensions);
	}
};

//#endregion
//#region apps/api/src/core/app.ts
/**
* The API's HTTP surface (Hono): one app for the Cloudflare Worker and the Node entry. It registers every route of the
* contract's table (`API_ROUTES`, docs/paypal/SPEC.md §13) and dispatches each to its workstream's handler, or answers
* 501 `not-implemented` while there is none. Around every handler: a request id, security headers, CORS for the
* configured origins only, body limits per route, the session check on `session` routes, and RFC 9457 problems for
* every error (an unexpected error is logged as its class name only and answers 500 `internal`).
*
* Owner: foundation. Workstreams add handlers in src/routes/<area>.ts, never here.
*/
/** Every workstream's handlers. A route id appears in at most one map (test/smoke.test.ts). */
const HANDLER_MAPS = [
	sessionHandlers,
	aiHandlers,
	twinHandlers,
	webhookHandlers,
	deskHandlers,
	checkHandlers,
	healthHandlers
];
const SECURITY_HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
	"Cross-Origin-Resource-Policy": "cross-origin"
};
const CORS_HEADERS = {
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, Content-Type",
	"Access-Control-Expose-Headers": `Retry-After, ${REQUEST_ID_HEADER}`,
	"Access-Control-Max-Age": "600"
};
function respondProblem(c, body) {
	const withId = {
		...body,
		requestId: c.get("requestId")
	};
	if (body.retryAfter !== void 0) c.header("Retry-After", String(body.retryAfter));
	return c.body(JSON.stringify(withId), body.status, { "Content-Type": "application/problem+json" });
}
function requestId(services) {
	return [...services.runtime.random(12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function bearer(c) {
	const header = c.req.header("authorization") ?? "";
	return /^Bearer ([A-Za-z0-9._~+/=-]{1,2048})$/u.exec(header)?.[1] ?? null;
}
/** The app over `services`. `maps` replaces the workstreams' handlers (tests of the cross-cutting rules only). */
function createApp(services, maps = HANDLER_MAPS) {
	const { config, logger, clock } = services.runtime;
	const allowed = new Set(config.allowedOrigins);
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("requestId", requestId(services));
		const origin = c.req.header("origin");
		const corsOk = origin !== void 0 && allowed.has(origin);
		if (c.req.method === "OPTIONS") {
			if (!corsOk) return respondProblem(c, problem("origin-not-allowed", "this origin may not call the API"));
			return c.body(null, 204, {
				...CORS_HEADERS,
				"Access-Control-Allow-Origin": origin,
				Vary: "Origin"
			});
		}
		await next();
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(name)) c.res.headers.set(name, value);
		c.res.headers.set(REQUEST_ID_HEADER, c.get("requestId"));
		if (corsOk) {
			c.res.headers.set("Access-Control-Allow-Origin", origin);
			c.res.headers.set("Access-Control-Expose-Headers", CORS_HEADERS["Access-Control-Expose-Headers"] ?? "");
			c.res.headers.append("Vary", "Origin");
		}
	});
	const handlers = /* @__PURE__ */ new Map();
	for (const map of maps) for (const [id, handler] of Object.entries(map)) handlers.set(id, handler);
	for (const route of API_ROUTES) app.on(route.method, route.path, async (c) => {
		const handler = handlers.get(route.id);
		if (handler === void 0) throw new ProblemError("not-implemented", `${route.method} ${route.path} is not implemented yet`);
		const limit = BODY_LIMITS[route.id] ?? 8192;
		const declared = Number(c.req.header("content-length") ?? "0");
		if (route.method === "POST" && Number.isFinite(declared) && declared > limit) throw new ProblemError("payload-too-large", `the body may not exceed ${String(limit)} bytes`);
		const now = clock();
		let payee = null;
		if (route.auth === "session") {
			const session = await services.sessions.check(bearer(c), now);
			if (!session.ok) throw new ProblemError("unauthorized", session.reason === "missing" ? "send Authorization: Bearer <session token>" : "the session token is not valid");
			payee = session.payee;
		}
		return await handler({
			c,
			services,
			payee,
			now
		});
	});
	app.notFound((c) => {
		return respondProblem(c, API_ROUTES.some((route) => matchesPath(route.path, c.req.path)) ? problem("method-not-allowed", `${c.req.method} is not allowed here`) : problem("not-found", "no such endpoint"));
	});
	app.onError((error, c) => {
		if (error instanceof ProblemError) return respondProblem(c, error.problem);
		logger.log("error", "request.failed", {
			requestId: c.get("requestId"),
			route: routePath(c),
			...errorFields(error)
		});
		return respondProblem(c, problem("internal", "the request failed"));
	});
	return app;
}
/** Whether `path` matches a route template (`:name` segments match one non-empty segment). */
function matchesPath(template, path) {
	const a = template.split("/");
	const b = path.split("/");
	return a.length === b.length && a.every((segment, i) => segment.startsWith(":") ? (b[i] ?? "") !== "" : segment === b[i]);
}

//#endregion
//#region apps/api/src/ai/factory.ts
function createAiProvider(deps) {
	const { mode, model } = deps.runtime.config.ai;
	const unavailable = {
		outcome: "unavailable",
		reason: mode === "disabled" ? "disabled" : "error"
	};
	return {
		kind: mode,
		model,
		structured: () => Promise.resolve(unavailable),
		toolTurn: () => Promise.resolve(unavailable)
	};
}

//#endregion
//#region apps/api/src/core/not-implemented.ts
/**
* The scaffold's placeholder for work a workstream has not delivered yet: a call answers 501 `not-implemented` with
* the area's name, so the route table, the entries and the health rows run end to end from day one, and a missing
* implementation is visible instead of silent.
*
* Owner: foundation. Workstreams delete their uses as they implement; nothing else may depend on it.
*/
/** An async method that rejects with the 501 problem of `area`. */
function pendingMethod(area) {
	return () => Promise.reject(new ProblemError("not-implemented", `${area} is not implemented yet`));
}

//#endregion
//#region apps/api/src/approvals/factory.ts
/**
* Builds the approval service (canonical proposal hash, HMAC tokens under `APPROVAL_HMAC_KEY`).
*
* Owner: reconciler workstream. Scaffold: every call answers 501 `not-implemented`, so nothing can be approved.
*/
function createApprovals(deps) {
	const pending = pendingMethod(`approvals (${deps.runtime.secrets.approvalHmacKey === void 0 ? "no key" : "key set"})`);
	return {
		hash: pending,
		issue: pending,
		verify: pending
	};
}

//#endregion
//#region viem@2.57.3/_esm/utils/data/isHex.js
function isHex(value, { strict = true } = {}) {
	if (!value) return false;
	if (typeof value !== "string") return false;
	return strict ? /^0x[0-9a-fA-F]*$/.test(value) : value.startsWith("0x");
}
var init_isHex = __esmMin((() => {}));

//#endregion
//#region viem@2.57.3/_esm/utils/data/size.js
/**
* @description Retrieves the size of the value (in bytes).
*
* @param value The value (hex or byte array) to retrieve the size of.
* @returns The size of the value (in bytes).
*/
function size(value) {
	if (isHex(value, { strict: false })) return Math.ceil((value.length - 2) / 2);
	return value.length;
}
var init_size = __esmMin((() => {
	init_isHex();
}));

//#endregion
//#region viem@2.57.3/_esm/errors/version.js
var version;
var init_version = __esmMin((() => {
	version = "2.57.3";
}));

//#endregion
//#region viem@2.57.3/_esm/errors/base.js
function walk(err, fn) {
	if (fn?.(err)) return err;
	if (err && typeof err === "object" && "cause" in err && err.cause !== void 0) return walk(err.cause, fn);
	return fn ? null : err;
}
var errorConfig, BaseError;
var init_base = __esmMin((() => {
	init_version();
	errorConfig = {
		getDocsUrl: ({ docsBaseUrl, docsPath = "", docsSlug }) => docsPath ? `${docsBaseUrl ?? "https://viem.sh"}${docsPath}${docsSlug ? `#${docsSlug}` : ""}` : void 0,
		version: `viem@${version}`
	};
	BaseError = class BaseError extends Error {
		constructor(shortMessage, args = {}) {
			const details = (() => {
				if (args.cause instanceof BaseError) return args.cause.details;
				if (args.cause?.message) return args.cause.message;
				return args.details;
			})();
			const docsPath = (() => {
				if (args.cause instanceof BaseError) return args.cause.docsPath || args.docsPath;
				return args.docsPath;
			})();
			const docsUrl = errorConfig.getDocsUrl?.({
				...args,
				docsPath
			});
			const message = [
				shortMessage || "An error occurred.",
				"",
				...args.metaMessages ? [...args.metaMessages, ""] : [],
				...docsUrl ? [`Docs: ${docsUrl}`] : [],
				...details ? [`Details: ${details}`] : [],
				...errorConfig.version ? [`Version: ${errorConfig.version}`] : []
			].join("\n");
			super(message, args.cause ? { cause: args.cause } : void 0);
			Object.defineProperty(this, "details", {
				enumerable: true,
				configurable: true,
				writable: true,
				value: void 0
			});
			Object.defineProperty(this, "docsPath", {
				enumerable: true,
				configurable: true,
				writable: true,
				value: void 0
			});
			Object.defineProperty(this, "metaMessages", {
				enumerable: true,
				configurable: true,
				writable: true,
				value: void 0
			});
			Object.defineProperty(this, "shortMessage", {
				enumerable: true,
				configurable: true,
				writable: true,
				value: void 0
			});
			Object.defineProperty(this, "version", {
				enumerable: true,
				configurable: true,
				writable: true,
				value: void 0
			});
			Object.defineProperty(this, "name", {
				enumerable: true,
				configurable: true,
				writable: true,
				value: "BaseError"
			});
			this.details = details;
			this.docsPath = docsPath;
			this.metaMessages = args.metaMessages;
			this.name = args.name ?? this.name;
			this.shortMessage = shortMessage;
			this.version = version;
		}
		walk(fn) {
			return walk(this, fn);
		}
	};
}));

//#endregion
//#region viem@2.57.3/_esm/errors/data.js
var SizeExceedsPaddingSizeError;
var init_data = __esmMin((() => {
	init_base();
	SizeExceedsPaddingSizeError = class extends BaseError {
		constructor({ size, targetSize, type }) {
			super(`${type.charAt(0).toUpperCase()}${type.slice(1).toLowerCase()} size (${size}) exceeds padding size (${targetSize}).`, { name: "SizeExceedsPaddingSizeError" });
		}
	};
}));

//#endregion
//#region viem@2.57.3/_esm/utils/data/pad.js
function pad(hexOrBytes, { dir, size = 32 } = {}) {
	if (typeof hexOrBytes === "string") return padHex(hexOrBytes, {
		dir,
		size
	});
	return padBytes(hexOrBytes, {
		dir,
		size
	});
}
function padHex(hex_, { dir, size = 32 } = {}) {
	if (size === null) return hex_;
	const hex = hex_.replace("0x", "");
	if (hex.length > size * 2) throw new SizeExceedsPaddingSizeError({
		size: Math.ceil(hex.length / 2),
		targetSize: size,
		type: "hex"
	});
	return `0x${hex[dir === "right" ? "padEnd" : "padStart"](size * 2, "0")}`;
}
function padBytes(bytes, { dir, size = 32 } = {}) {
	if (size === null) return bytes;
	if (bytes.length > size) throw new SizeExceedsPaddingSizeError({
		size: bytes.length,
		targetSize: size,
		type: "bytes"
	});
	const paddedBytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) {
		const padEnd = dir === "right";
		paddedBytes[padEnd ? i : size - i - 1] = bytes[padEnd ? i : bytes.length - i - 1];
	}
	return paddedBytes;
}
var init_pad = __esmMin((() => {
	init_data();
}));

//#endregion
//#region viem@2.57.3/_esm/errors/encoding.js
var IntegerOutOfRangeError, SizeOverflowError;
var init_encoding = __esmMin((() => {
	init_base();
	IntegerOutOfRangeError = class extends BaseError {
		constructor({ max, min, signed, size, value }) {
			super(`Number "${value}" is not in safe ${size ? `${size * 8}-bit ${signed ? "signed" : "unsigned"} ` : ""}integer range ${max ? `(${min} to ${max})` : `(above ${min})`}`, { name: "IntegerOutOfRangeError" });
		}
	};
	SizeOverflowError = class extends BaseError {
		constructor({ givenSize, maxSize }) {
			super(`Size cannot exceed ${maxSize} bytes. Given size: ${givenSize} bytes.`, { name: "SizeOverflowError" });
		}
	};
}));

//#endregion
//#region viem@2.57.3/_esm/utils/encoding/fromHex.js
function assertSize(hexOrBytes, { size: size$1 }) {
	if (size(hexOrBytes) > size$1) throw new SizeOverflowError({
		givenSize: size(hexOrBytes),
		maxSize: size$1
	});
}
var init_fromHex = __esmMin((() => {
	init_encoding();
	init_size();
}));

//#endregion
//#region viem@2.57.3/_esm/utils/encoding/toHex.js
/**
* Encodes a string, number, bigint, or ByteArray into a hex string
*
* - Docs: https://viem.sh/docs/utilities/toHex
* - Example: https://viem.sh/docs/utilities/toHex#usage
*
* @param value Value to encode.
* @param opts Options.
* @returns Hex value.
*
* @example
* import { toHex } from 'viem'
* const data = toHex('Hello world')
* // '0x48656c6c6f20776f726c6421'
*
* @example
* import { toHex } from 'viem'
* const data = toHex(420)
* // '0x1a4'
*
* @example
* import { toHex } from 'viem'
* const data = toHex('Hello world', { size: 32 })
* // '0x48656c6c6f20776f726c64210000000000000000000000000000000000000000'
*/
function toHex(value, opts = {}) {
	if (typeof value === "number" || typeof value === "bigint") return numberToHex(value, opts);
	if (typeof value === "string") return stringToHex(value, opts);
	if (typeof value === "boolean") return boolToHex(value, opts);
	return bytesToHex(value, opts);
}
/**
* Encodes a boolean into a hex string
*
* - Docs: https://viem.sh/docs/utilities/toHex#booltohex
*
* @param value Value to encode.
* @param opts Options.
* @returns Hex value.
*
* @example
* import { boolToHex } from 'viem'
* const data = boolToHex(true)
* // '0x1'
*
* @example
* import { boolToHex } from 'viem'
* const data = boolToHex(false)
* // '0x0'
*
* @example
* import { boolToHex } from 'viem'
* const data = boolToHex(true, { size: 32 })
* // '0x0000000000000000000000000000000000000000000000000000000000000001'
*/
function boolToHex(value, opts = {}) {
	const hex = `0x${Number(value)}`;
	if (typeof opts.size === "number") {
		assertSize(hex, { size: opts.size });
		return pad(hex, { size: opts.size });
	}
	return hex;
}
/**
* Encodes a bytes array into a hex string
*
* - Docs: https://viem.sh/docs/utilities/toHex#bytestohex
*
* @param value Value to encode.
* @param opts Options.
* @returns Hex value.
*
* @example
* import { bytesToHex } from 'viem'
* const data = bytesToHex(Uint8Array.from([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 33])
* // '0x48656c6c6f20576f726c6421'
*
* @example
* import { bytesToHex } from 'viem'
* const data = bytesToHex(Uint8Array.from([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 33]), { size: 32 })
* // '0x48656c6c6f20576f726c64210000000000000000000000000000000000000000'
*/
function bytesToHex(value, opts = {}) {
	let string = "";
	for (let i = 0; i < value.length; i++) string += hexes[value[i]];
	const hex = `0x${string}`;
	if (typeof opts.size === "number") {
		assertSize(hex, { size: opts.size });
		return pad(hex, {
			dir: "right",
			size: opts.size
		});
	}
	return hex;
}
/**
* Encodes a number or bigint into a hex string
*
* - Docs: https://viem.sh/docs/utilities/toHex#numbertohex
*
* @param value Value to encode.
* @param opts Options.
* @returns Hex value.
*
* @example
* import { numberToHex } from 'viem'
* const data = numberToHex(420)
* // '0x1a4'
*
* @example
* import { numberToHex } from 'viem'
* const data = numberToHex(420, { size: 32 })
* // '0x00000000000000000000000000000000000000000000000000000000000001a4'
*/
function numberToHex(value_, opts = {}) {
	const { signed, size } = opts;
	const value = BigInt(value_);
	let maxValue;
	if (size) {
		if (signed) maxValue = (1n << BigInt(size) * 8n - 1n) - 1n;
		else maxValue = 2n ** (BigInt(size) * 8n) - 1n;
	} else if (typeof value_ === "number") maxValue = BigInt(Number.MAX_SAFE_INTEGER);
	const minValue = typeof maxValue === "bigint" && signed ? -maxValue - 1n : 0;
	if (maxValue && value > maxValue || value < minValue) {
		const suffix = typeof value_ === "bigint" ? "n" : "";
		throw new IntegerOutOfRangeError({
			max: maxValue ? `${maxValue}${suffix}` : void 0,
			min: `${minValue}${suffix}`,
			signed,
			size,
			value: `${value_}${suffix}`
		});
	}
	const hex = `0x${(signed && value < 0 ? (1n << BigInt(size * 8)) + BigInt(value) : value).toString(16)}`;
	if (size) return pad(hex, { size });
	return hex;
}
/**
* Encodes a UTF-8 string into a hex string
*
* - Docs: https://viem.sh/docs/utilities/toHex#stringtohex
*
* @param value Value to encode.
* @param opts Options.
* @returns Hex value.
*
* @example
* import { stringToHex } from 'viem'
* const data = stringToHex('Hello World!')
* // '0x48656c6c6f20576f726c6421'
*
* @example
* import { stringToHex } from 'viem'
* const data = stringToHex('Hello World!', { size: 32 })
* // '0x48656c6c6f20576f726c64210000000000000000000000000000000000000000'
*/
function stringToHex(value_, opts = {}) {
	return bytesToHex(encoder$1.encode(value_), opts);
}
var hexes, encoder$1;
var init_toHex = __esmMin((() => {
	init_encoding();
	init_pad();
	init_fromHex();
	hexes = /*#__PURE__*/ Array.from({ length: 256 }, (_v, i) => i.toString(16).padStart(2, "0"));
	encoder$1 = /*#__PURE__*/ new TextEncoder();
}));

//#endregion
//#region viem@2.57.3/_esm/utils/encoding/toBytes.js
/**
* Encodes a UTF-8 string, hex value, bigint, number or boolean to a byte array.
*
* - Docs: https://viem.sh/docs/utilities/toBytes
* - Example: https://viem.sh/docs/utilities/toBytes#usage
*
* @param value Value to encode.
* @param opts Options.
* @returns Byte array value.
*
* @example
* import { toBytes } from 'viem'
* const data = toBytes('Hello world')
* // Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 33])
*
* @example
* import { toBytes } from 'viem'
* const data = toBytes(420)
* // Uint8Array([1, 164])
*
* @example
* import { toBytes } from 'viem'
* const data = toBytes(420, { size: 4 })
* // Uint8Array([0, 0, 1, 164])
*/
function toBytes$1(value, opts = {}) {
	if (typeof value === "number" || typeof value === "bigint") return numberToBytes(value, opts);
	if (typeof value === "boolean") return boolToBytes(value, opts);
	if (isHex(value)) return hexToBytes(value, opts);
	return stringToBytes(value, opts);
}
/**
* Encodes a boolean into a byte array.
*
* - Docs: https://viem.sh/docs/utilities/toBytes#booltobytes
*
* @param value Boolean value to encode.
* @param opts Options.
* @returns Byte array value.
*
* @example
* import { boolToBytes } from 'viem'
* const data = boolToBytes(true)
* // Uint8Array([1])
*
* @example
* import { boolToBytes } from 'viem'
* const data = boolToBytes(true, { size: 32 })
* // Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
*/
function boolToBytes(value, opts = {}) {
	const bytes = /* @__PURE__ */ new Uint8Array(1);
	bytes[0] = Number(value);
	if (typeof opts.size === "number") {
		assertSize(bytes, { size: opts.size });
		return pad(bytes, { size: opts.size });
	}
	return bytes;
}
function charCodeToBase16(char) {
	if (char >= charCodeMap.zero && char <= charCodeMap.nine) return char - charCodeMap.zero;
	if (char >= charCodeMap.A && char <= charCodeMap.F) return char - (charCodeMap.A - 10);
	if (char >= charCodeMap.a && char <= charCodeMap.f) return char - (charCodeMap.a - 10);
}
/**
* Encodes a hex string into a byte array.
*
* - Docs: https://viem.sh/docs/utilities/toBytes#hextobytes
*
* @param hex Hex string to encode.
* @param opts Options.
* @returns Byte array value.
*
* @example
* import { hexToBytes } from 'viem'
* const data = hexToBytes('0x48656c6c6f20776f726c6421')
* // Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 33])
*
* @example
* import { hexToBytes } from 'viem'
* const data = hexToBytes('0x48656c6c6f20776f726c6421', { size: 32 })
* // Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 33, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
*/
function hexToBytes(hex_, opts = {}) {
	let hex = hex_;
	if (opts.size) {
		assertSize(hex, { size: opts.size });
		hex = pad(hex, {
			dir: "right",
			size: opts.size
		});
	}
	let hexString = hex.slice(2);
	if (hexString.length % 2) hexString = `0${hexString}`;
	const length = hexString.length / 2;
	const bytes = new Uint8Array(length);
	for (let index = 0, j = 0; index < length; index++) {
		const nibbleLeft = charCodeToBase16(hexString.charCodeAt(j++));
		const nibbleRight = charCodeToBase16(hexString.charCodeAt(j++));
		if (nibbleLeft === void 0 || nibbleRight === void 0) throw new BaseError(`Invalid byte sequence ("${hexString[j - 2]}${hexString[j - 1]}" in "${hexString}").`);
		bytes[index] = nibbleLeft * 16 + nibbleRight;
	}
	return bytes;
}
/**
* Encodes a number into a byte array.
*
* - Docs: https://viem.sh/docs/utilities/toBytes#numbertobytes
*
* @param value Number to encode.
* @param opts Options.
* @returns Byte array value.
*
* @example
* import { numberToBytes } from 'viem'
* const data = numberToBytes(420)
* // Uint8Array([1, 164])
*
* @example
* import { numberToBytes } from 'viem'
* const data = numberToBytes(420, { size: 4 })
* // Uint8Array([0, 0, 1, 164])
*/
function numberToBytes(value, opts) {
	return hexToBytes(numberToHex(value, opts));
}
/**
* Encodes a UTF-8 string into a byte array.
*
* - Docs: https://viem.sh/docs/utilities/toBytes#stringtobytes
*
* @param value String to encode.
* @param opts Options.
* @returns Byte array value.
*
* @example
* import { stringToBytes } from 'viem'
* const data = stringToBytes('Hello world!')
* // Uint8Array([72, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100, 33])
*
* @example
* import { stringToBytes } from 'viem'
* const data = stringToBytes('Hello world!', { size: 32 })
* // Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 33, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
*/
function stringToBytes(value, opts = {}) {
	const bytes = encoder.encode(value);
	if (typeof opts.size === "number") {
		assertSize(bytes, { size: opts.size });
		return pad(bytes, {
			dir: "right",
			size: opts.size
		});
	}
	return bytes;
}
var encoder, charCodeMap;
var init_toBytes = __esmMin((() => {
	init_base();
	init_isHex();
	init_pad();
	init_fromHex();
	init_toHex();
	encoder = /*#__PURE__*/ new TextEncoder();
	charCodeMap = {
		zero: 48,
		nine: 57,
		A: 65,
		F: 70,
		a: 97,
		f: 102
	};
}));

//#endregion
//#region @noble/hashes@1.8.0/esm/_u64.js
function fromBig(n, le = false) {
	if (le) return {
		h: Number(n & U32_MASK64),
		l: Number(n >> _32n & U32_MASK64)
	};
	return {
		h: Number(n >> _32n & U32_MASK64) | 0,
		l: Number(n & U32_MASK64) | 0
	};
}
function split(lst, le = false) {
	const len = lst.length;
	let Ah = new Uint32Array(len);
	let Al = new Uint32Array(len);
	for (let i = 0; i < len; i++) {
		const { h, l } = fromBig(lst[i], le);
		[Ah[i], Al[i]] = [h, l];
	}
	return [Ah, Al];
}
var U32_MASK64, _32n, rotlSH, rotlSL, rotlBH, rotlBL;
var init__u64 = __esmMin((() => {
	U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
	_32n = /* @__PURE__ */ BigInt(32);
	rotlSH = (h, l, s) => h << s | l >>> 32 - s;
	rotlSL = (h, l, s) => l << s | h >>> 32 - s;
	rotlBH = (h, l, s) => l << s - 32 | h >>> 64 - s;
	rotlBL = (h, l, s) => h << s - 32 | l >>> 64 - s;
}));

//#endregion
//#region @noble/hashes@1.8.0/esm/utils.js
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
/** Checks if something is Uint8Array. Be careful: nodejs Buffer will return true. */
function isBytes(a) {
	return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
/** Asserts something is positive integer. */
function anumber(n) {
	if (!Number.isSafeInteger(n) || n < 0) throw new Error("positive integer expected, got " + n);
}
/** Asserts something is Uint8Array. */
function abytes(b, ...lengths) {
	if (!isBytes(b)) throw new Error("Uint8Array expected");
	if (lengths.length > 0 && !lengths.includes(b.length)) throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
/** Asserts a hash instance has not been destroyed / finished */
function aexists(instance, checkFinished = true) {
	if (instance.destroyed) throw new Error("Hash instance has been destroyed");
	if (checkFinished && instance.finished) throw new Error("Hash#digest() has already been called");
}
/** Asserts output is properly-sized byte array */
function aoutput(out, instance) {
	abytes(out);
	const min = instance.outputLen;
	if (out.length < min) throw new Error("digestInto() expects output buffer of length at least " + min);
}
/** Cast u8 / u16 / u32 to u32. */
function u32(arr) {
	return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
/** Zeroize a byte array. Warning: JS provides no guarantees. */
function clean(...arrays) {
	for (let i = 0; i < arrays.length; i++) arrays[i].fill(0);
}
/** The byte swap operation for uint32 */
function byteSwap(word) {
	return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
}
/** In place byte swap for Uint32Array */
function byteSwap32(arr) {
	for (let i = 0; i < arr.length; i++) arr[i] = byteSwap(arr[i]);
	return arr;
}
/**
* Converts string to bytes using UTF8 encoding.
* @example utf8ToBytes('abc') // Uint8Array.from([97, 98, 99])
*/
function utf8ToBytes(str) {
	if (typeof str !== "string") throw new Error("string expected");
	return new Uint8Array(new TextEncoder().encode(str));
}
/**
* Normalizes (non-hex) string or Uint8Array to Uint8Array.
* Warning: when Uint8Array is passed, it would NOT get copied.
* Keep in mind for future mutable operations.
*/
function toBytes(data) {
	if (typeof data === "string") data = utf8ToBytes(data);
	abytes(data);
	return data;
}
/** Wraps hash function, creating an interface on top of it */
function createHasher(hashCons) {
	const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
	const tmp = hashCons();
	hashC.outputLen = tmp.outputLen;
	hashC.blockLen = tmp.blockLen;
	hashC.create = () => hashCons();
	return hashC;
}
var isLE, swap32IfBE, Hash;
var init_utils = __esmMin((() => {
	isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
	swap32IfBE = isLE ? (u) => u : byteSwap32;
	Hash = class {};
}));

//#endregion
//#region @noble/hashes@1.8.0/esm/sha3.js
/** `keccakf1600` internal function, additionally allows to adjust round count. */
function keccakP(s, rounds = 24) {
	const B = /* @__PURE__ */ new Uint32Array(10);
	for (let round = 24 - rounds; round < 24; round++) {
		for (let x = 0; x < 10; x++) B[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
		for (let x = 0; x < 10; x += 2) {
			const idx1 = (x + 8) % 10;
			const idx0 = (x + 2) % 10;
			const B0 = B[idx0];
			const B1 = B[idx0 + 1];
			const Th = rotlH(B0, B1, 1) ^ B[idx1];
			const Tl = rotlL(B0, B1, 1) ^ B[idx1 + 1];
			for (let y = 0; y < 50; y += 10) {
				s[x + y] ^= Th;
				s[x + y + 1] ^= Tl;
			}
		}
		let curH = s[2];
		let curL = s[3];
		for (let t = 0; t < 24; t++) {
			const shift = SHA3_ROTL[t];
			const Th = rotlH(curH, curL, shift);
			const Tl = rotlL(curH, curL, shift);
			const PI = SHA3_PI[t];
			curH = s[PI];
			curL = s[PI + 1];
			s[PI] = Th;
			s[PI + 1] = Tl;
		}
		for (let y = 0; y < 50; y += 10) {
			for (let x = 0; x < 10; x++) B[x] = s[y + x];
			for (let x = 0; x < 10; x++) s[y + x] ^= ~B[(x + 2) % 10] & B[(x + 4) % 10];
		}
		s[0] ^= SHA3_IOTA_H[round];
		s[1] ^= SHA3_IOTA_L[round];
	}
	clean(B);
}
var _0n, _1n, _2n, _7n, _256n, _0x71n, SHA3_PI, SHA3_ROTL, _SHA3_IOTA, IOTAS, SHA3_IOTA_H, SHA3_IOTA_L, rotlH, rotlL, Keccak, gen, keccak_256;
var init_sha3 = __esmMin((() => {
	init__u64();
	init_utils();
	_0n = BigInt(0);
	_1n = BigInt(1);
	_2n = BigInt(2);
	_7n = BigInt(7);
	_256n = BigInt(256);
	_0x71n = BigInt(113);
	SHA3_PI = [];
	SHA3_ROTL = [];
	_SHA3_IOTA = [];
	for (let round = 0, R = _1n, x = 1, y = 0; round < 24; round++) {
		[x, y] = [y, (2 * x + 3 * y) % 5];
		SHA3_PI.push(2 * (5 * y + x));
		SHA3_ROTL.push((round + 1) * (round + 2) / 2 % 64);
		let t = _0n;
		for (let j = 0; j < 7; j++) {
			R = (R << _1n ^ (R >> _7n) * _0x71n) % _256n;
			if (R & _2n) t ^= _1n << (_1n << /* @__PURE__ */ BigInt(j)) - _1n;
		}
		_SHA3_IOTA.push(t);
	}
	IOTAS = split(_SHA3_IOTA, true);
	SHA3_IOTA_H = IOTAS[0];
	SHA3_IOTA_L = IOTAS[1];
	rotlH = (h, l, s) => s > 32 ? rotlBH(h, l, s) : rotlSH(h, l, s);
	rotlL = (h, l, s) => s > 32 ? rotlBL(h, l, s) : rotlSL(h, l, s);
	Keccak = class Keccak extends Hash {
		constructor(blockLen, suffix, outputLen, enableXOF = false, rounds = 24) {
			super();
			this.pos = 0;
			this.posOut = 0;
			this.finished = false;
			this.destroyed = false;
			this.enableXOF = false;
			this.blockLen = blockLen;
			this.suffix = suffix;
			this.outputLen = outputLen;
			this.enableXOF = enableXOF;
			this.rounds = rounds;
			anumber(outputLen);
			if (!(0 < blockLen && blockLen < 200)) throw new Error("only keccak-f1600 function is supported");
			this.state = /* @__PURE__ */ new Uint8Array(200);
			this.state32 = u32(this.state);
		}
		clone() {
			return this._cloneInto();
		}
		keccak() {
			swap32IfBE(this.state32);
			keccakP(this.state32, this.rounds);
			swap32IfBE(this.state32);
			this.posOut = 0;
			this.pos = 0;
		}
		update(data) {
			aexists(this);
			data = toBytes(data);
			abytes(data);
			const { blockLen, state } = this;
			const len = data.length;
			for (let pos = 0; pos < len;) {
				const take = Math.min(blockLen - this.pos, len - pos);
				for (let i = 0; i < take; i++) state[this.pos++] ^= data[pos++];
				if (this.pos === blockLen) this.keccak();
			}
			return this;
		}
		finish() {
			if (this.finished) return;
			this.finished = true;
			const { state, suffix, pos, blockLen } = this;
			state[pos] ^= suffix;
			if ((suffix & 128) !== 0 && pos === blockLen - 1) this.keccak();
			state[blockLen - 1] ^= 128;
			this.keccak();
		}
		writeInto(out) {
			aexists(this, false);
			abytes(out);
			this.finish();
			const bufferOut = this.state;
			const { blockLen } = this;
			for (let pos = 0, len = out.length; pos < len;) {
				if (this.posOut >= blockLen) this.keccak();
				const take = Math.min(blockLen - this.posOut, len - pos);
				out.set(bufferOut.subarray(this.posOut, this.posOut + take), pos);
				this.posOut += take;
				pos += take;
			}
			return out;
		}
		xofInto(out) {
			if (!this.enableXOF) throw new Error("XOF is not possible for this instance");
			return this.writeInto(out);
		}
		xof(bytes) {
			anumber(bytes);
			return this.xofInto(new Uint8Array(bytes));
		}
		digestInto(out) {
			aoutput(out, this);
			if (this.finished) throw new Error("digest() was already called");
			this.writeInto(out);
			this.destroy();
			return out;
		}
		digest() {
			return this.digestInto(new Uint8Array(this.outputLen));
		}
		destroy() {
			this.destroyed = true;
			clean(this.state);
		}
		_cloneInto(to) {
			const { blockLen, suffix, outputLen, rounds, enableXOF } = this;
			to || (to = new Keccak(blockLen, suffix, outputLen, enableXOF, rounds));
			to.state32.set(this.state32);
			to.pos = this.pos;
			to.posOut = this.posOut;
			to.finished = this.finished;
			to.rounds = rounds;
			to.suffix = suffix;
			to.outputLen = outputLen;
			to.enableXOF = enableXOF;
			to.destroyed = this.destroyed;
			return to;
		}
	};
	gen = (suffix, blockLen, outputLen) => createHasher(() => new Keccak(blockLen, suffix, outputLen));
	keccak_256 = /* @__PURE__ */ (() => gen(1, 136, 32))();
}));

//#endregion
//#region viem@2.57.3/_esm/utils/hash/keccak256.js
function keccak256(value, to_) {
	const to = to_ || "hex";
	const bytes = keccak_256(isHex(value, { strict: false }) ? toBytes$1(value) : value);
	if (to === "bytes") return bytes;
	return toHex(bytes);
}
var init_keccak256 = __esmMin((() => {
	init_sha3();
	init_isHex();
	init_toBytes();
	init_toHex();
}));

//#endregion
//#region viem@2.57.3/_esm/errors/address.js
var InvalidAddressError;
var init_address = __esmMin((() => {
	init_base();
	InvalidAddressError = class extends BaseError {
		constructor({ address }) {
			super(`Address "${address}" is invalid.`, {
				metaMessages: ["- Address must be a hex value of 20 bytes (40 hex characters).", "- Address must match its checksum counterpart."],
				name: "InvalidAddressError"
			});
		}
	};
}));

//#endregion
//#region viem@2.57.3/_esm/utils/lru.js
var LruMap;
var init_lru = __esmMin((() => {
	LruMap = class extends Map {
		constructor(size) {
			super();
			Object.defineProperty(this, "maxSize", {
				enumerable: true,
				configurable: true,
				writable: true,
				value: void 0
			});
			this.maxSize = size;
		}
		get(key) {
			const value = super.get(key);
			if (super.has(key)) {
				super.delete(key);
				super.set(key, value);
			}
			return value;
		}
		set(key, value) {
			if (super.has(key)) super.delete(key);
			super.set(key, value);
			if (this.maxSize && this.size > this.maxSize) {
				const firstKey = super.keys().next().value;
				if (firstKey !== void 0) super.delete(firstKey);
			}
			return this;
		}
	};
}));

//#endregion
//#region viem@2.57.3/_esm/utils/address/getAddress.js
function checksumAddress(address_, chainId) {
	if (checksumAddressCache.has(`${address_}.${chainId}`)) return checksumAddressCache.get(`${address_}.${chainId}`);
	const hexAddress = chainId ? `${chainId}${address_.toLowerCase()}` : address_.substring(2).toLowerCase();
	const hash = keccak256(stringToBytes(hexAddress), "bytes");
	const address = (chainId ? hexAddress.substring(`${chainId}0x`.length) : hexAddress).split("");
	for (let i = 0; i < 40; i += 2) {
		if (hash[i >> 1] >> 4 >= 8 && address[i]) address[i] = address[i].toUpperCase();
		if ((hash[i >> 1] & 15) >= 8 && address[i + 1]) address[i + 1] = address[i + 1].toUpperCase();
	}
	const result = `0x${address.join("")}`;
	checksumAddressCache.set(`${address_}.${chainId}`, result);
	return result;
}
function getAddress(address, chainId) {
	if (!isAddress(address, { strict: false })) throw new InvalidAddressError({ address });
	return checksumAddress(address, chainId);
}
var checksumAddressCache;
var init_getAddress = __esmMin((() => {
	init_address();
	init_toBytes();
	init_keccak256();
	init_lru();
	init_isAddress();
	checksumAddressCache = /*#__PURE__*/ new LruMap(8192);
}));

//#endregion
//#region viem@2.57.3/_esm/utils/address/isAddress.js
function isAddress(address, options) {
	const { strict = true } = options ?? {};
	const cacheKey = `${address}.${strict}`;
	if (isAddressCache.has(cacheKey)) return isAddressCache.get(cacheKey);
	const result = (() => {
		if (!addressRegex.test(address)) return false;
		if (address.toLowerCase() === address) return true;
		if (strict) return checksumAddress(address) === address;
		return true;
	})();
	isAddressCache.set(cacheKey, result);
	return result;
}
var addressRegex, isAddressCache;
var init_isAddress = __esmMin((() => {
	init_lru();
	init_getAddress();
	addressRegex = /^0x[a-fA-F0-9]{40}$/;
	isAddressCache = /*#__PURE__*/ new LruMap(8192);
}));

//#endregion
//#region viem@2.57.3/_esm/constants/address.js
const zeroAddress = "0x0000000000000000000000000000000000000000";

//#endregion
//#region packages/chains/src/deployment-status.ts
const DEPLOYMENT_STATUS = {};

//#endregion
//#region packages/chains/src/generated/deployments.ts
/** Every recorded PayLinkV2 deployment, keyed by chain ID. Empty until the first testnet deployment is recorded. */
const DEPLOYMENT_RECORDS = {
	10143: {
		network: "Monad testnet",
		address: "0x448eCce9711860502806A3d5B021a4f9Ba715082",
		release: "2.0.0",
		method: "CREATE2",
		deployer: "0x0c397c6c8F94EAA6662eE548fA140e6DfEd4aea6",
		txHash: "0xb86e75367a73e933f3c99a6092357f4b785bf7fdd2c4b299c193e4f903cb4d6a",
		blockNumber: 69331735n,
		initCodeHash: "0x289dcd6477a467fcd8cc185bb4fb6c3cd58c06132d08fa11822f21f824627ac5",
		maskedRuntimeHash: "0x59c48f00a8e437c74bf6b0b5ac1363149c8977c9185d1cf23405fa09c18aeb4d",
		runtimeCodeHash: "0x317f0eaea391e57c616af85fe1ef99e99662d587c8834cc7edf51edb82bc738d",
		explorers: [{
			name: "MonadVision",
			origin: "https://testnet.monadvision.com"
		}, {
			name: "Monadscan",
			origin: "https://testnet.monadscan.com"
		}]
	},
	31611: {
		network: "Mezo testnet",
		address: "0x448eCce9711860502806A3d5B021a4f9Ba715082",
		release: "2.0.0",
		method: "CREATE2",
		deployer: "0x3fE5f968b61523CcCe599B99bD4c0cfc39c666cA",
		txHash: "0x1662fb5126d7582947cc77ba2f96266c4f1a561c0e1761f7e4c6249e19e1165e",
		blockNumber: 16183660n,
		initCodeHash: "0x289dcd6477a467fcd8cc185bb4fb6c3cd58c06132d08fa11822f21f824627ac5",
		maskedRuntimeHash: "0x59c48f00a8e437c74bf6b0b5ac1363149c8977c9185d1cf23405fa09c18aeb4d",
		runtimeCodeHash: "0x09fd3c933abc2feea7097ddd6247fbbb4ce702efd3b61ca3a1e73e05a152db47",
		explorers: [{
			name: "Mezo Explorer",
			origin: "https://explorer.test.mezo.org"
		}]
	},
	84532: {
		network: "Base Sepolia",
		address: "0x448eCce9711860502806A3d5B021a4f9Ba715082",
		release: "2.0.0",
		method: "CREATE2",
		deployer: "0x0c397c6c8F94EAA6662eE548fA140e6DfEd4aea6",
		txHash: "0x2969321db8ce3b1ed12ddf038268c30de4896aaf9e9bad9db2e92e20d886b5ed",
		blockNumber: 47859253n,
		initCodeHash: "0x289dcd6477a467fcd8cc185bb4fb6c3cd58c06132d08fa11822f21f824627ac5",
		maskedRuntimeHash: "0x59c48f00a8e437c74bf6b0b5ac1363149c8977c9185d1cf23405fa09c18aeb4d",
		runtimeCodeHash: "0x4835a6a4919a183d0952d502806812158e1443891510a52cf5314d85f72670d8",
		explorers: [{
			name: "Basescan",
			origin: "https://sepolia.basescan.org"
		}, {
			name: "Blockscout",
			origin: "https://base-sepolia.blockscout.com"
		}]
	}
};

//#endregion
//#region packages/chains/src/generated/gas.ts
/** Gas-limit bounds derived from the snapshot (Ethereum gas prices). */
const SNAPSHOT_GAS_LIMITS = {
	payWithAuthorization: {
		floor: 143000n,
		ceiling: 215000n
	},
	pay: {
		floor: 102000n,
		ceiling: 153000n
	},
	payWithPermit: {
		floor: 136000n,
		ceiling: 204000n
	},
	payNative: {
		floor: 98000n,
		ceiling: 147000n
	},
	cancel: {
		floor: 54000n,
		ceiling: 81000n
	},
	cancelBySig: {
		floor: 62000n,
		ceiling: 93000n
	}
};
/**
* What the registry's gas tables cite as evidence: each profile's anvil hardfork and, for a fork, its block. Kept apart
* from GAS_MEASUREMENTS so that clients, which need only the bounds, do not ship the measurements.
*/
const GAS_PROFILE_PROVENANCE = {
	base: { hardfork: "Beryl" },
	ethereum: { hardfork: "Bpo1" },
	london: { hardfork: "London" },
	mezo: {
		hardfork: "Prague",
		forkBlock: 16140641
	},
	monad: { hardfork: "MonadTen" }
};
/** Gas-limit bounds of the networks whose gas schedule differs from Ethereum's, from their own estimates. */
const EMULATED_GAS_LIMITS = { monad: {
	payWithAuthorization: {
		floor: 224000n,
		ceiling: 336000n
	},
	pay: {
		floor: 159000n,
		ceiling: 239000n
	},
	payWithPermit: {
		floor: 217000n,
		ceiling: 326000n
	},
	payNative: {
		floor: 125000n,
		ceiling: 188000n
	},
	cancel: {
		floor: 70000n,
		ceiling: 105000n
	},
	cancelBySig: {
		floor: 89000n,
		ceiling: 134000n
	}
} };
/** Gas-limit bounds of the networks measured on an anvil fork of themselves, from the fork's estimates. */
const FORK_GAS_LIMITS = { mezo: {
	payWithAuthorization: {
		floor: 167000n,
		ceiling: 251000n
	},
	pay: {
		floor: 112000n,
		ceiling: 168000n
	},
	payWithPermit: {
		floor: 161000n,
		ceiling: 242000n
	},
	payNative: {
		floor: 102000n,
		ceiling: 153000n
	},
	cancel: {
		floor: 58000n,
		ceiling: 87000n
	},
	cancelBySig: {
		floor: 67000n,
		ceiling: 101000n
	}
} };

//#endregion
//#region packages/chains/src/define.ts
/** Building blocks shared by the chain definitions in `src/chains/`. */
/**
* Gas table of the v2 chains with Ethereum gas prices (Base, Arbitrum): the Foundry snapshot, checked against
* eth_estimateGas on anvil's Ethereum, Base and London profiles. Provisional until re-measured on the chain.
*/
const SNAPSHOT_GAS_TABLE = {
	source: "snapshot",
	provisional: true,
	evidence: "protocol/snapshots/PayLinkV2.json (forge, mock tokens), covered by anvil estimates (packages/chains/data/gas-measurements.json)",
	limits: SNAPSHOT_GAS_LIMITS
};
/**
* Gas table of Monad: eth_estimateGas on anvil's Monad emulation (hardfork MonadTen), because Monad prices cold
* state and ecrecover differently and charges the gas limit. Provisional (L) until re-measured on Monad testnet.
*/
const MONAD_GAS_TABLE = {
	source: "emulated",
	provisional: true,
	evidence: `anvil --network monad (hardfork ${GAS_PROFILE_PROVENANCE.monad.hardfork}), mock tokens: packages/chains/data/gas-measurements.json`,
	limits: EMULATED_GAS_LIMITS.monad
};
/**
* Gas table of Mezo testnet: eth_estimateGas on an anvil fork of Mezo testnet (ADR 0017), with MUSD and native BTC as
* the chain holds them, the canonical CREATE2 factory, and the repository's mocks only where Mezo has nothing to measure
* (an EIP-3009 token, an ERC-1271 payee). anvil prices gas like Ethereum (L for mezod, whose estimate of the CREATE2
* deployment equals the fork's). Mezo charges at least half of the limit, which these bounds keep below the gas used.
*/
const MEZO_GAS_TABLE = {
	source: "fork",
	provisional: true,
	evidence: `anvil fork of Mezo testnet at block ${String(GAS_PROFILE_PROVENANCE.mezo.forkBlock)} (hardfork ${GAS_PROFILE_PROVENANCE.mezo.hardfork}), MUSD and native BTC: packages/chains/data/fork-gas-measurements.json`,
	limits: FORK_GAS_LIMITS.mezo
};
/**
* Relay timing of the v2 chains until inclusion latency is measured on each (invoice spec §13.3, audit finding
* A-04): 120 s, four times the relayer's 30 s stuck-transaction replacement interval (PAYLINK-V2-SPEC §3.7). That
* covers the pre-broadcast re-simulation, the broadcast and up to three fee-bump replacements on chains whose
* blocks take seconds or less, and leaves 480 s of the recommended 600 s authorization window (invoice spec §8.3)
* for the request to reach the relayer.
*/
const DEFAULT_RELAY_TIMING = {
	minRemainingSeconds: 120,
	provisional: true,
	basis: "4 x the relayer's 30 s stuck-transaction replacement interval (PAYLINK-V2-SPEC §3.7): re-simulation, broadcast and up to three fee bumps; re-measure on the chain"
};
/** Turns a generated deployment record into a registry deployment with its lifecycle status (default `active`). */
function deploymentFromRecord(record, status) {
	if (record === void 0) return null;
	return {
		address: record.address,
		status: status ?? "active",
		release: record.release,
		method: record.method,
		deployer: record.deployer,
		txHash: record.txHash,
		blockNumber: record.blockNumber,
		initCodeHash: record.initCodeHash,
		maskedRuntimeHash: record.maskedRuntimeHash,
		runtimeCodeHash: record.runtimeCodeHash
	};
}
/** The recorded canonical deployment of `chainId`, or `null` when none is recorded yet. */
function recordedDeployment(chainId) {
	return deploymentFromRecord(DEPLOYMENT_RECORDS[chainId], DEPLOYMENT_STATUS[chainId]);
}
/** A native-coin token entry (`Invoice.token = address(0)`, paid through `payNative`). */
function nativeToken(fields) {
	return {
		kind: "native",
		address: zeroAddress,
		capabilities: {
			eip3009: false,
			eip2612: false,
			native: true
		},
		pendingVerification: [],
		...fields
	};
}

//#endregion
//#region packages/chains/src/chains/arbitrum-sepolia.ts
/**
* Arbitrum Sepolia (421614): optional chain of the Colosseum edition, tier T1 if Sepolia ETH reaches the
* deployer (PAYLINK-V2-SPEC §2.2, §3.4). Confidence C. The spec states USDC's decimals but not its
* capabilities, so EIP-3009 and EIP-2612 stay off (payers use approve + pay) until fork-nightly confirms them.
*/
const arbitrumSepolia = {
	chainId: 421614,
	caip2: "eip155:421614",
	key: "arbitrum-sepolia",
	name: "Arbitrum Sepolia",
	label: "ARB",
	testnet: true,
	local: false,
	status: "enabled",
	tier: "T1",
	protocol: "v2",
	editions: ["all", "base"],
	nativeCurrency: {
		name: "Sepolia Ether",
		symbol: "ETH",
		decimals: 18
	},
	rpc: [{
		url: "https://sepolia-rollup.arbitrum.io/rpc",
		confidence: "C"
	}],
	rpcLimits: {},
	explorers: [{
		name: "Arbiscan",
		url: "https://sepolia.arbiscan.io",
		confidence: "C"
	}, {
		name: "Blockscout",
		url: "https://arbitrum-sepolia.blockscout.com",
		confidence: "C"
	}],
	tokens: [{
		kind: "erc20",
		symbol: "USDC",
		name: "USDC (Circle)",
		address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
		decimals: 6,
		capabilities: {
			eip3009: false,
			eip2612: false,
			native: false
		},
		eip712Domain: null,
		listing: "default",
		confidence: "C",
		pendingVerification: [],
		note: "Capabilities not stated in spec §3.4: approve + pay only until fork-nightly confirms EIP-3009/EIP-2612."
	}],
	deniedTokens: [],
	contracts: {},
	gasModel: { chargesGasLimit: false },
	gas: SNAPSHOT_GAS_TABLE,
	relay: DEFAULT_RELAY_TIMING,
	deployment: recordedDeployment(421614),
	v1: null,
	indexing: null,
	confidence: {
		chainId: "C",
		rpc: "C",
		explorers: "C"
	},
	notes: ["Same PayLinkV2 artifact as Base; added only if Sepolia ETH reaches the deployer by Oct 9 (spec §2.2).", "Arbitrum's eth_estimateGas includes the L1 posting cost in L2 gas units (L): the snapshot ceilings cover execution only, so re-measure before relaying there."]
};

//#endregion
//#region packages/chains/src/generated/v1.ts
/** The frozen v1 app's network configuration (Arc Microgrants entry, ADR 0010). `address` stays null until v1 is deployed. */
const V1_CONFIG = {
	network: "mainnet",
	chainId: 5042,
	rpc: "https://rpc.mainnet.arc.io",
	explorer: "https://explorer.arc.io",
	address: null
};

//#endregion
//#region packages/chains/src/chains/arc.ts
/**
* Arc mainnet (5042): PayLink **v1** only, the Arc Microgrants entry (PAYLINK-V2-SPEC §2.3, ADR 0010).
* There is no v2 deployment, so the SDK refuses v2 links on this chain. The v1 facts (RPC, explorer and
* contract address) are generated from the frozen `web/config.js`. Confidence C (spec §3.4); the explorer
* comes from the v1 config only (U).
*/
const arc = {
	chainId: V1_CONFIG.chainId,
	caip2: "eip155:5042",
	key: "arc",
	name: "Arc mainnet",
	label: "ARC",
	testnet: false,
	local: false,
	status: "enabled",
	tier: null,
	protocol: "v1",
	editions: [],
	nativeCurrency: {
		name: "USDC",
		symbol: "USDC",
		decimals: 18
	},
	rpc: [{
		url: V1_CONFIG.rpc,
		confidence: "C"
	}],
	rpcLimits: {},
	explorers: [],
	tokens: [nativeToken({
		symbol: "USDC",
		name: "USDC (native)",
		decimals: 18,
		listing: "default",
		confidence: "C",
		note: "Native USDC with 18 decimals, paid as msg.value. v1 uses native value only."
	}), {
		kind: "erc20",
		symbol: "USDC",
		name: "USDC (ERC-20 interface)",
		address: "0x3600000000000000000000000000000000000000",
		decimals: 6,
		capabilities: {
			eip3009: true,
			eip2612: false,
			native: false
		},
		eip712Domain: {
			name: "USDC",
			version: "2"
		},
		listing: "hidden",
		confidence: "C",
		pendingVerification: [],
		note: "ERC-20 view of the same native USDC balance, with 6 decimals: never add amounts across the two representations."
	}],
	deniedTokens: [],
	contracts: { create2Deployer: {
		address: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
		confidence: "C"
	} },
	gasModel: { chargesGasLimit: false },
	gas: null,
	relay: null,
	deployment: null,
	v1: {
		address: V1_CONFIG.address,
		rpc: V1_CONFIG.rpc,
		explorer: V1_CONFIG.explorer,
		app: "https://nambininasafidison.github.io/paylink/web/",
		tag: "arc-microgrants-v1"
	},
	indexing: null,
	confidence: {
		chainId: "C",
		rpc: "C",
		explorers: "U"
	},
	notes: ["Gas is paid in native USDC. The v1 deployment is estimated at 920,964 gas (spec §2.3).", "Multicall3, Permit2 and the CREATE2 deployer exist on Arc mainnet (C)."]
};

//#endregion
//#region packages/chains/src/chains/base-sepolia.ts
/** Base Sepolia (84532): the Colosseum edition, tier T0 (PAYLINK-V2-SPEC §2.2, §3.4). Confidence C throughout. */
const baseSepolia = {
	chainId: 84532,
	caip2: "eip155:84532",
	key: "base-sepolia",
	name: "Base Sepolia",
	label: "BASE",
	testnet: true,
	local: false,
	status: "enabled",
	tier: "T0",
	protocol: "v2",
	editions: ["all", "base"],
	nativeCurrency: {
		name: "Sepolia Ether",
		symbol: "ETH",
		decimals: 18
	},
	rpc: [{
		url: "https://sepolia.base.org",
		confidence: "C"
	}],
	rpcLimits: {},
	explorers: [{
		name: "Basescan",
		url: "https://sepolia.basescan.org",
		confidence: "C"
	}, {
		name: "Blockscout",
		url: "https://base-sepolia.blockscout.com",
		confidence: "C"
	}],
	tokens: [{
		kind: "erc20",
		symbol: "USDC",
		name: "USDC (Circle)",
		address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		decimals: 6,
		capabilities: {
			eip3009: true,
			eip2612: true,
			native: false
		},
		eip712Domain: null,
		listing: "default",
		confidence: "C",
		pendingVerification: [],
		note: "Circle FiatTokenV2_2. Not the ...dCF7c address printed in Base's docs, which fails the EIP-55 check."
	}],
	deniedTokens: [],
	contracts: {},
	gasModel: { chargesGasLimit: false },
	gas: SNAPSHOT_GAS_TABLE,
	relay: DEFAULT_RELAY_TIMING,
	deployment: recordedDeployment(84532),
	v1: null,
	indexing: null,
	confidence: {
		chainId: "C",
		rpc: "C",
		explorers: "C"
	},
	notes: ["Gas is paid in Sepolia ETH from faucets (spec §6.2)."]
};

//#endregion
//#region packages/chains/src/chains/ethereum-sepolia.ts
/**
* Ethereum Sepolia (11155111): the PayPal edition's chain (ADR 0018, decision D-CHAIN of 2026-10-21). Every fact below
* was read on chain through the registry's RPC on 2026-10-21 (block 11,958,755; docs/research/paypal/sepolia.md);
* confidence C unless a note says otherwise.
*
* Disabled for every other edition, and offered by the PayPal edition only (it takes the chain explicitly, as the Mezo
* edition takes Mezo testnet): `/`, `/monad/`, `/base/` and `/mezo/` do not change. No PayLinkV2 deployment is recorded
* yet: the owner deploys the release at its CREATE2 address with the deploy kit, and until
* `protocol/deployments/11155111.json` exists the chain reads "not deployed yet" and nothing can be signed or paid there.
* No relayer serves it (D-SCOPE cut): payers pay their own Sepolia gas.
*/
const ethereumSepolia = {
	chainId: 11155111,
	caip2: "eip155:11155111",
	key: "ethereum-sepolia",
	name: "Ethereum Sepolia",
	label: "ETH",
	testnet: true,
	local: false,
	status: "disabled",
	tier: "later",
	protocol: "v2",
	editions: ["paypal"],
	nativeCurrency: {
		name: "Sepolia Ether",
		symbol: "ETH",
		decimals: 18
	},
	rpc: [{
		url: "https://ethereum-sepolia-rpc.publicnode.com",
		confidence: "C"
	}],
	rpcLimits: { maxLogBlockRange: 5e4 },
	explorers: [{
		name: "Etherscan",
		url: "https://sepolia.etherscan.io",
		confidence: "C"
	}],
	tokens: [{
		kind: "erc20",
		symbol: "USDC",
		name: "USDC (Circle)",
		address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
		decimals: 6,
		capabilities: {
			eip3009: true,
			eip2612: true,
			native: false
		},
		eip712Domain: {
			name: "USDC",
			version: "2"
		},
		listing: "default",
		confidence: "C",
		pendingVerification: [],
		note: "Circle FiatToken (ZeppelinOS proxy; receiveWithAuthorization and permit in its implementation). Test USDC from faucet.circle.com."
	}, {
		kind: "erc20",
		symbol: "PYUSD",
		name: "PayPal USD (Paxos)",
		address: "0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9",
		decimals: 6,
		capabilities: {
			eip3009: true,
			eip2612: true,
			native: false
		},
		eip712Domain: {
			name: "PayPal USD",
			version: "1"
		},
		listing: "listed",
		confidence: "C",
		pendingVerification: [],
		note: "Paxos PaxosTokenV2 behind an upgradeable proxy: Paxos can pause it and freeze any address, including PayLinkV2's. An already-used EIP-3009 nonce returns without a transfer (PayLinkV2 then reverts ReceivedMismatch)."
	}],
	deniedTokens: [],
	contracts: {
		create2Deployer: {
			address: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
			confidence: "C",
			note: "Canonical runtime, checked live: PayLinkV2 deploys at 0x448e…5082 (rehearsed on an anvil fork)."
		},
		multicall3: {
			address: "0xcA11bde05977b3631167028862bE2a173976CA11",
			confidence: "C",
			note: "Code present, checked live."
		}
	},
	gasModel: { chargesGasLimit: false },
	gas: SNAPSHOT_GAS_TABLE,
	relay: DEFAULT_RELAY_TIMING,
	deployment: recordedDeployment(11155111),
	v1: null,
	indexing: null,
	confidence: {
		chainId: "C",
		rpc: "C",
		explorers: "C"
	},
	notes: [
		"Gas is Sepolia ETH, paid by the payer: no relayer serves this chain (ADR 0018). eth_getLogs spans at most 50,000 blocks (C).",
		"Logs older than about 10,000 blocks may read as unavailable on the public RPC (C): retry, or read from the payment's receipt.",
		"PYUSD: test tokens from faucet.paxos.com or the Google Cloud Web3 faucet (U); Paxos can pause the token or freeze an address."
	]
};

//#endregion
//#region packages/chains/src/chains/mezo-testnet.ts
/**
* Mezo testnet (31611, "matsnet"): the Mezo edition (PAYLINK-V2-SPEC §9, ADR 0017). Facts from
* docs/research/mezo.md, re-read on chain on 2026-10-13; confidence C unless a note says otherwise.
*
* Disabled until the Mezo edition goes live (ADR 0017): the deploy kit already targets it, because the deployment
* has to exist first. MUSD supports EIP-2612 only, so MUSD payments use `payWithPermit` (the payer pays BTC gas) or
* approve + pay; with PayLinkV2 no relayer can make them gasless (ADR 0017).
*/
const mezoTestnet = {
	chainId: 31611,
	caip2: "eip155:31611",
	key: "mezo-testnet",
	name: "Mezo testnet",
	label: "MEZO",
	testnet: true,
	local: false,
	status: "disabled",
	tier: "later",
	protocol: "v2",
	editions: ["all", "mezo"],
	nativeCurrency: {
		name: "Bitcoin",
		symbol: "BTC",
		decimals: 18
	},
	rpc: [{
		url: "https://rpc.test.mezo.org",
		confidence: "C"
	}],
	rpcLimits: {
		maxLogBlockRange: 1e4,
		inconsistentTxIndex: true
	},
	explorers: [{
		name: "Mezo Explorer",
		url: "https://explorer.test.mezo.org",
		confidence: "C"
	}],
	tokens: [{
		kind: "erc20",
		symbol: "MUSD",
		name: "MUSD (Mezo)",
		address: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
		decimals: 18,
		capabilities: {
			eip3009: false,
			eip2612: true,
			native: false
		},
		eip712Domain: {
			name: "Mezo USD",
			version: "1"
		},
		listing: "default",
		confidence: "C",
		pendingVerification: [],
		note: "EIP-2612 with ECDSA permits only, no EIP-3009, no fee or hook, not upgradeable; its owner can let any address burn MUSD (issuer risk). Borrowed against test BTC (at least 2,000 MUSD of debt), never from a faucet."
	}, nativeToken({
		symbol: "BTC",
		name: "Bitcoin (native)",
		decimals: 18,
		listing: "listed",
		confidence: "C"
	})],
	deniedTokens: [],
	contracts: {
		create2Deployer: {
			address: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
			confidence: "C",
			note: "Canonical runtime, checked live: PayLinkV2 deploys at 0x448e…5082."
		},
		btcErc20: {
			address: "0x7b7C000000000000000000000000000000000000",
			confidence: "L",
			note: "BTC ERC-20 precompile; not on the token allowlist (L)."
		},
		musdBorrowerOperations: {
			address: "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5",
			confidence: "C"
		}
	},
	gasModel: {
		chargesGasLimit: false,
		minChargedPercentOfLimit: 50
	},
	gas: MEZO_GAS_TABLE,
	relay: DEFAULT_RELAY_TIMING,
	deployment: recordedDeployment(31611),
	v1: null,
	indexing: null,
	confidence: {
		chainId: "C",
		rpc: "C",
		explorers: "C"
	},
	notes: [
		"Gas is test BTC at about 130 to 300 wei; at least 50 % of the gas limit is charged (C): send clamp(estimate x 1.10, floor, ceiling).",
		"Cancun opcodes run (C), not London as Mezo's docs say; the paris artifact runs either way. eth_getLogs spans at most 10,000 blocks (C).",
		"No gasless MUSD payment with PayLinkV2: MUSD has no EIP-3009 (ADR 0017). Test BTC: faucet.test.mezo.org; test MUSD is borrowed against it."
	]
};

//#endregion
//#region packages/chains/src/chains/monad.ts
/**
* Monad mainnet (143): ready but disabled, tier T2 (PAYLINK-V2-SPEC §2.1, §3.4, §6.6). Registry only:
* the spec gives the token addresses (C) but no RPC, explorer, decimals or capabilities for this chain.
* Decimals are assumed equal to the issuers' testnet deployments and must be confirmed on chain before the
* chain is enabled (`createRegistry` refuses an enabled chain with pending verifications).
*/
const monad = {
	chainId: 143,
	caip2: "eip155:143",
	key: "monad",
	name: "Monad mainnet",
	label: "MONAD",
	testnet: false,
	local: false,
	status: "disabled",
	tier: "T2",
	protocol: "v2",
	editions: ["all", "monad"],
	nativeCurrency: {
		name: "Monad",
		symbol: "MON",
		decimals: 18
	},
	rpc: [],
	rpcLimits: {},
	explorers: [],
	tokens: [{
		kind: "erc20",
		symbol: "AUSD",
		name: "AUSD (Agora)",
		address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
		decimals: 6,
		capabilities: {
			eip3009: false,
			eip2612: false,
			native: false
		},
		eip712Domain: null,
		listing: "default",
		confidence: "C",
		pendingVerification: [
			"decimals",
			"capabilities",
			"eip712Domain"
		]
	}, {
		kind: "erc20",
		symbol: "USDC",
		name: "USDC (Circle)",
		address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
		decimals: 6,
		capabilities: {
			eip3009: false,
			eip2612: false,
			native: false
		},
		eip712Domain: null,
		listing: "hidden",
		confidence: "C",
		pendingVerification: [
			"decimals",
			"capabilities",
			"eip712Domain"
		]
	}],
	deniedTokens: [],
	contracts: {},
	gasModel: {
		chargesGasLimit: true,
		reserveBalance: 10n * 10n ** 18n
	},
	gas: MONAD_GAS_TABLE,
	relay: DEFAULT_RELAY_TIMING,
	deployment: recordedDeployment(143),
	v1: null,
	indexing: null,
	confidence: {
		chainId: "UV",
		rpc: "U",
		explorers: "U"
	},
	notes: ["Deployed only on demand (spec §6.6): about 0.3-0.5 MON for the deployment.", "Monad charges the gas limit, not the gas used (C); an EOA must keep a 10 MON reserve balance (C)."]
};

//#endregion
//#region packages/chains/src/chains/monad-testnet.ts
/**
* Monad testnet (10143): the Monad Metropolis edition, tier T0 (PAYLINK-V2-SPEC §2.1, §3.4).
* Confidence: chainId C; RPC L; explorers C; AUSD C; USDC C; helpers L.
*/
const monadTestnet = {
	chainId: 10143,
	caip2: "eip155:10143",
	key: "monad-testnet",
	name: "Monad testnet",
	label: "MONAD",
	testnet: true,
	local: false,
	status: "enabled",
	tier: "T0",
	protocol: "v2",
	editions: ["all", "monad"],
	nativeCurrency: {
		name: "Monad",
		symbol: "MON",
		decimals: 18
	},
	rpc: [{
		url: "https://testnet-rpc.monad.xyz",
		rateLimitRps: 50,
		confidence: "L"
	}, {
		url: "https://rpc-testnet.monadinfra.com",
		rateLimitRps: 20,
		confidence: "L"
	}],
	rpcLimits: { maxLogBlockRange: 100 },
	explorers: [{
		name: "MonadVision",
		url: "https://testnet.monadvision.com",
		confidence: "C"
	}, {
		name: "Monadscan",
		url: "https://testnet.monadscan.com",
		confidence: "C"
	}],
	tokens: [{
		kind: "erc20",
		symbol: "AUSD",
		name: "AUSD (Agora)",
		address: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC",
		decimals: 6,
		capabilities: {
			eip3009: true,
			eip2612: true,
			native: false
		},
		eip712Domain: null,
		listing: "default",
		confidence: "C",
		pendingVerification: [],
		note: "Default token of the Monad edition. The EIP-712 domain is read from the chain (not stated in the spec)."
	}, {
		kind: "erc20",
		symbol: "USDC",
		name: "USDC (Circle)",
		address: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
		decimals: 6,
		capabilities: {
			eip3009: true,
			eip2612: false,
			native: false
		},
		eip712Domain: {
			name: "USDC",
			version: "2"
		},
		listing: "hidden",
		confidence: "C",
		pendingVerification: [],
		note: "Circle USDC, hidden in the demo. The spec lists EIP-3009 only; EIP-2612 stays off until fork-nightly confirms it."
	}],
	deniedTokens: [{
		address: "0xf817257fed379853cDe0fa4F97AB987181B1E5Ea",
		reason: "Not Circle's USDC: never use (PAYLINK-V2-SPEC §3.4).",
		confidence: "C"
	}],
	contracts: {
		ausdFaucet: {
			address: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C",
			confidence: "C",
			note: "AUSD faucet proxy, requestFunds(address): 10,000 AUSD per drip; relayer onboarding only. Checked from the sandbox on 2026-10-07: an OZ transparent proxy whose implementation exposes requestFunds(address) (0x544c7cf9) and token() = AUSD; on an anvil fork the 60 s cooldown is global (any second request within 60 s reverts with error 0x20e5bc67, whoever sends it and whoever it funds).",
			gas: {
				floor: 130000n,
				ceiling: 195000n
			}
		},
		multicall3: {
			address: "0xcA11bde05977b3631167028862bE2a173976CA11",
			confidence: "L"
		},
		permit2: {
			address: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
			confidence: "L",
			note: "Not used before Oct 12 (spec §2.7)."
		},
		agoraInstantSettlement: {
			address: "0x1Aa8958Aa34cEC8096EF4381cb335effe977b0ae",
			confidence: "L",
			note: "Agora Instant Settlement AUSD/CTK, tier T2."
		},
		agoraWhitelister: {
			address: "0x7c10F56d6f04a51376393a1C3670e966863F6BD5",
			confidence: "L",
			note: "Tier T2."
		}
	},
	gasModel: {
		chargesGasLimit: true,
		txGasCap: 30000000n,
		reserveBalance: 10n * 10n ** 18n
	},
	gas: MONAD_GAS_TABLE,
	relay: DEFAULT_RELAY_TIMING,
	deployment: recordedDeployment(10143),
	v1: null,
	indexing: {
		hypersync: ["https://monad-testnet.hypersync.xyz", "https://10143.hypersync.xyz"],
		confidence: "L"
	},
	confidence: {
		chainId: "C",
		rpc: "L",
		explorers: "C"
	},
	notes: [
		"Monad charges the gas limit, not the gas used (C): send clamp(estimate x 1.10, floor, ceiling).",
		"An EOA must keep a 10 MON reserve balance (C); the relayer never sends value.",
		"Public RPC eth_getLogs is capped at 100 blocks (L); the per-transaction gas cap is 30M (L).",
		"Cold SLOAD/SSTORE cost 8,100 gas and cold account access 10,100 (L): gas bounds come from anvil's Monad emulation (MonadTen) and must be re-measured on testnet with AUSD."
	]
};

//#endregion
//#region packages/chains/src/chains/index.ts
/** Every chain of PAYLINK-V2-SPEC §3.4 that the product uses, in band-selector order. */
const CHAIN_DEFINITIONS = [
	monadTestnet,
	monad,
	baseSepolia,
	arbitrumSepolia,
	mezoTestnet,
	ethereumSepolia,
	arc
];

//#endregion
//#region packages/chains/src/registry.ts
init_getAddress(), init_isAddress();
/** Every edition and every function, for validation. */
const EDITIONS = /* @__PURE__ */ new Set([
	"all",
	"monad",
	"base",
	"mezo",
	"paypal"
]);
const FUNCTIONS = [
	"payWithAuthorization",
	"pay",
	"payWithPermit",
	"payNative",
	"cancel",
	"cancelBySig"
];
const MAX_UINT53 = 2 ** 53 - 1;
const LOCAL_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/**
* Largest relay margin (`RelayTiming.minRemainingSeconds`): half of the recommended 600 s EIP-3009 authorization
* window (invoice spec §8.3), so that a payer client's default authorization stays relayable for most of its life.
*/
const MAX_RELAY_MARGIN_SECONDS = 300;
/** Thrown by `createRegistry` with every problem found, one per line. */
var RegistryError = class extends Error {
	issues;
	constructor(issues) {
		super(`invalid chain registry:\n- ${issues.join("\n- ")}`);
		this.name = "RegistryError";
		this.issues = issues;
	}
};
/** Thrown when a chain ID is not in the registry. */
var UnknownChainError = class extends Error {
	chainId;
	constructor(chainId) {
		super(`chain ${chainId} is not in the PayLink registry`);
		this.name = "UnknownChainError";
		this.chainId = chainId;
	}
};
const sameAddress = (a, b) => a.toLowerCase() === b.toLowerCase();
function checkAddress(issues, where, value) {
	if (!isAddress(value, { strict: false })) issues.push(`${where}: ${value} is not an address`);
	else if (getAddress(value) !== value) issues.push(`${where}: ${value} is not EIP-55 checksummed (expected ${getAddress(value)})`);
}
function checkUrl(issues, where, value, allowLocal, originOnly) {
	let url;
	try {
		url = new URL(value);
	} catch {
		issues.push(`${where}: ${value} is not a URL`);
		return;
	}
	const local = allowLocal && LOCAL_HOSTS.has(url.hostname);
	if (url.protocol !== "https:" && !(local && url.protocol === "http:")) issues.push(`${where}: ${value} must use https`);
	if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") issues.push(`${where}: ${value} must not carry credentials, a query or a fragment`);
	if (originOnly && value !== url.origin) issues.push(`${where}: ${value} must be a bare origin (no path, no trailing slash)`);
}
function checkToken(issues, chain, token, index) {
	const where = `chain ${chain.chainId} token[${index}] ${token.symbol}`;
	checkAddress(issues, where, token.address);
	if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) issues.push(`${where}: decimals must be an integer in [0, 36]`);
	if (token.symbol.trim() === "" || token.name.trim() === "") issues.push(`${where}: symbol and name are required`);
	const capabilities = token.capabilities;
	if (token.kind === "native") {
		if (token.address !== "0x0000000000000000000000000000000000000000" || !capabilities.native || capabilities.eip3009 || capabilities.eip2612) issues.push(`${where}: a native token has the zero address and only the native capability`);
	} else if (token.address === "0x0000000000000000000000000000000000000000" || capabilities.native) issues.push(`${where}: an ERC-20 token has a non-zero address and no native capability`);
	if (chain.deployment !== null && sameAddress(token.address, chain.deployment.address)) issues.push(`${where}: the token cannot be the PayLinkV2 deployment (invoice shape rule)`);
	if (chain.deniedTokens.some((denied) => sameAddress(denied.address, token.address))) issues.push(`${where}: the token is on the chain's deny list`);
	if (chain.status === "enabled" && token.pendingVerification.length > 0) issues.push(`${where}: an enabled chain cannot carry unverified facts (${token.pendingVerification.join(", ")})`);
}
function checkChain(issues, chain) {
	const where = `chain ${chain.chainId}`;
	if (!Number.isSafeInteger(chain.chainId) || chain.chainId < 1 || chain.chainId > MAX_UINT53) issues.push(`${where}: chainId must be an integer in [1, 2^53 - 1]`);
	if (chain.caip2 !== `eip155:${chain.chainId}`) issues.push(`${where}: caip2 must be eip155:${chain.chainId}`);
	if (chain.local && (!chain.testnet || chain.key !== "local")) issues.push(`${where}: a local chain has key "local" and is a testnet`);
	for (const edition of chain.editions) if (!EDITIONS.has(edition)) issues.push(`${where}: unknown edition ${edition}`);
	chain.rpc.forEach((rpc, i) => {
		checkUrl(issues, `${where} rpc[${i}]`, rpc.url, chain.local, false);
	});
	chain.explorers.forEach((explorer, i) => {
		checkUrl(issues, `${where} explorer[${i}]`, explorer.url, chain.local, true);
	});
	const minCharged = chain.gasModel.minChargedPercentOfLimit;
	if (minCharged !== void 0 && (!Number.isInteger(minCharged) || minCharged < 1 || minCharged > 100 || chain.gasModel.chargesGasLimit)) issues.push(`${where}: gasModel.minChargedPercentOfLimit must be an integer in [1, 100], on a chain that does not charge the whole limit`);
	if (chain.status === "enabled" && chain.rpc.length === 0) issues.push(`${where}: an enabled chain needs at least one RPC endpoint`);
	const seen = /* @__PURE__ */ new Set();
	let defaults = 0;
	chain.tokens.forEach((token, i) => {
		checkToken(issues, chain, token, i);
		const id = token.address.toLowerCase();
		if (seen.has(id)) issues.push(`${where}: token ${token.address} is listed twice`);
		seen.add(id);
		defaults += token.listing === "default" ? 1 : 0;
	});
	if (defaults > 1) issues.push(`${where}: at most one default token`);
	for (const denied of chain.deniedTokens) checkAddress(issues, `${where} denied`, denied.address);
	for (const [name, helper] of Object.entries(chain.contracts)) {
		checkAddress(issues, `${where} contracts.${name}`, helper.address);
		if (helper.gas !== void 0 && (helper.gas.floor <= 0n || helper.gas.ceiling < helper.gas.floor)) issues.push(`${where}: gas bounds of contracts.${name} must satisfy 0 < floor <= ceiling`);
	}
	if (chain.protocol === "v2") {
		if (chain.gas === null) issues.push(`${where}: a v2 chain needs a gas table`);
		else for (const fn of FUNCTIONS) {
			const bounds = chain.gas.limits[fn];
			if (bounds.floor <= 0n || bounds.ceiling < bounds.floor) issues.push(`${where}: gas bounds of ${fn} must satisfy 0 < floor <= ceiling`);
		}
		if (chain.relay === null) issues.push(`${where}: a v2 chain needs relay timing`);
		else if (!Number.isSafeInteger(chain.relay.minRemainingSeconds) || chain.relay.minRemainingSeconds < 1 || chain.relay.minRemainingSeconds > MAX_RELAY_MARGIN_SECONDS) issues.push(`${where}: relay.minRemainingSeconds must be an integer in [1, ${String(MAX_RELAY_MARGIN_SECONDS)}]`);
		if (chain.v1 !== null) issues.push(`${where}: a v2 chain carries no v1 info`);
		if (chain.deployment !== null) {
			checkAddress(issues, `${where} deployment`, chain.deployment.address);
			if (chain.deployment.address === "0x0000000000000000000000000000000000000000") issues.push(`${where}: the deployment address cannot be zero`);
		}
	} else {
		if (chain.gas !== null || chain.relay !== null || chain.deployment !== null || chain.editions.length > 0) issues.push(`${where}: a v1 chain has no v2 gas table, relay timing, deployment or edition`);
		if (chain.v1 === null) issues.push(`${where}: a v1 chain needs its v1 info`);
		else if (chain.v1.address !== null) checkAddress(issues, `${where} v1.address`, chain.v1.address);
	}
}
function freezeDeep(value) {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) freezeDeep(child);
	}
	return value;
}
/**
* Validates the definitions and returns a frozen registry. Throws `RegistryError` listing every problem.
* Chain IDs must be unique, and so must the keys of non-local chains.
*/
function createRegistry(definitions) {
	const issues = [];
	const byId = /* @__PURE__ */ new Map();
	const keys = /* @__PURE__ */ new Set();
	for (const chain of definitions) {
		checkChain(issues, chain);
		if (byId.has(chain.chainId)) issues.push(`chain ${chain.chainId}: defined twice`);
		if (!chain.local && keys.has(chain.key)) issues.push(`chain ${chain.chainId}: key ${chain.key} is used twice`);
		byId.set(chain.chainId, chain);
		keys.add(chain.key);
	}
	if (issues.length > 0) throw new RegistryError(issues);
	const chains = freezeDeep([...definitions]);
	return Object.freeze({
		chains,
		get: (chainId) => byId.get(chainId),
		getOrThrow: (chainId) => {
			const chain = byId.get(chainId);
			if (chain === void 0) throw new UnknownChainError(chainId);
			return chain;
		},
		v2Target: (chainId) => {
			const chain = byId.get(chainId);
			if (chain?.protocol !== "v2" || chain.deployment === null) return;
			return {
				chain,
				deployment: chain.deployment
			};
		},
		findToken: (chainId, address) => byId.get(chainId)?.tokens.find((token) => sameAddress(token.address, address)),
		findDenied: (chainId, address) => byId.get(chainId)?.deniedTokens.find((denied) => sameAddress(denied.address, address)),
		forEdition: (edition, options) => chains.filter((chain) => (edition === "all" ? chain.editions.length > 0 : chain.editions.includes(edition)) && (options?.includeDisabled === true || chain.status === "enabled"))
	});
}

//#endregion
//#region packages/chains/src/index.ts
/**
* `@paylink/chains`: the PayLink chain registry (PAYLINK-V2-SPEC §3.4, invoice spec §4.2).
*
* @packageDocumentation
*/
/**
* The shipped registry: every chain of PAYLINK-V2-SPEC §3.4 used by the product, validated at load. Marked pure so a
* client bundle that builds its own registry from the chains it serves (apps/web/src/core/registry.ts) drops it, and
* with it the chains of the other editions.
*/
const registry = /* @__PURE__ */ createRegistry(CHAIN_DEFINITIONS);

//#endregion
//#region apps/api/src/chain/factory.ts
/**
* Builds the chain reader for Ethereum Sepolia from the registry (`@paylink/chains`, RPC and deployment), read-only.
*
* Owner: reconciler workstream. Scaffold: reads answer 501 `not-implemented`; `deployed` already follows the registry.
*/
function createChainReader(deps) {
	const chainId = deps.runtime.config.chainId;
	const pending = pendingMethod("chain reads");
	return {
		chainId,
		deployed: registry.v2Target(chainId) !== void 0,
		observe: pending,
		observeMany: pending
	};
}

//#endregion
//#region apps/api/src/paypal/factory.ts
/**
* Builds the PayPal client for a runtime: the HTTP client against `runtime.config.paypal.baseUrl` (token cached in the
* Global store) in `sandbox` mode, the PayPal fake in `fake` mode.
*
* Owner: PayPal spine workstream. Scaffold: every operation answers 501 `not-implemented`.
*/
function createPayPalClient(deps) {
	const pending = pendingMethod(`the PayPal client (${deps.runtime.config.paypal.mode})`);
	return {
		token: pending,
		searchInvoices: pending,
		createInvoice: pending,
		sendInvoice: pending,
		getInvoice: pending,
		recordPayment: pending,
		deletePayment: pending,
		cancelInvoice: pending,
		remindInvoice: pending,
		verifyWebhookSignature: pending,
		createWebhook: pending
	};
}

//#endregion
//#region apps/api/src/session/factory.ts
/**
* Builds the session service (EIP-712 `PayLinkSession` verification, HMAC tokens under `SESSION_HMAC_KEY`).
*
* Owner: reconciler workstream. Scaffold: opening a session answers 501; no token is ever valid, so every session route
* answers 401 once its handler exists and before sessions do.
*/
function createSessions(deps) {
	const configured = deps.runtime.secrets.sessionHmacKey !== void 0;
	return {
		open: pendingMethod("sessions"),
		check: (token) => Promise.resolve({
			ok: false,
			reason: token === null ? "missing" : configured ? "bad-mac" : "malformed"
		})
	};
}

//#endregion
//#region apps/api/src/core/services.ts
/**
* The services a route handler, the webhook and the cron use, assembled once per runtime from each area's factory. The
* entries (src/worker/index.ts, src/node/main.ts) never change when an area's implementation does: each workstream
* replaces the body of its own factory.
*
* | Service     | Factory (owner)                                   |
* |-------------|---------------------------------------------------|
* | `paypal`    | src/paypal/factory.ts (PayPal spine)              |
* | `stores`    | given by the entry: src/worker/durable.ts or src/store/memory.ts (reconciler) |
* | `chain`     | src/chain/factory.ts (reconciler)                 |
* | `sessions`  | src/session/factory.ts (reconciler)               |
* | `approvals` | src/approvals/factory.ts (reconciler)             |
* | `ai`        | src/ai/factory.ts (AI)                            |
*
* Owner: foundation.
*/
function createServices(runtime, stores) {
	const deps = {
		runtime,
		stores
	};
	return {
		runtime,
		paypal: createPayPalClient(deps),
		stores,
		chain: createChainReader(deps),
		sessions: createSessions(deps),
		approvals: createApprovals(deps),
		ai: createAiProvider(deps)
	};
}

//#endregion
//#region apps/api/src/reconciler/cron.ts
async function runCron(services, now) {
	services.runtime.logger.log("info", "cron.idle", {
		at: new Date(now).toISOString(),
		reason: "not-implemented"
	});
	return await Promise.resolve({
		checked: 0,
		backoffMs: 0,
		purged: false
	});
}

//#endregion
//#region apps/api/src/store/memory.ts
/**
* In-memory stores for the Node entry and tests: the same contract as the Durable Objects (src/worker/durable.ts), held
* by the process and lost when it stops (which loses no truth: the state is a rebuildable cache).
*
* Owner: reconciler workstream. Scaffold: every method answers 501 `not-implemented`.
*/
function createMemoryStores() {
	const pending = pendingMethod("the in-memory store");
	const payee = (address) => ({
		payee: address,
		getTwin: pending,
		putTwin: pending,
		listTwins: pending,
		getProposal: pending,
		putProposal: pending,
		listProposals: pending,
		transitionProposal: pending,
		putAutoRecord: pending,
		listAutoRecords: pending,
		putAlert: pending,
		clearAlert: pending,
		listAlerts: pending,
		audit: pending,
		listAudit: pending,
		useQuota: pending,
		purge: pending
	});
	const global = {
		getToken: pending,
		putToken: pending,
		spendAiBudget: pending,
		markWebhookEvent: pending,
		scheduleCheck: pending,
		unscheduleCheck: pending,
		dueChecks: pending,
		noteHealth: pending,
		readHealth: pending,
		purge: pending
	};
	return {
		payee,
		global: () => global
	};
}

//#endregion
//#region apps/api/src/worker/durable.ts
/**
* The two Durable Objects of the API (docs/paypal/SPEC.md §6.1, §11), SQLite-backed (the only kind the Workers Free plan
* offers, Cloudflare Durable Objects pricing page): `Payee`, one per payee address (twins, proposals, auto-records,
* alerts, audit, quotas), and `Global`, one for the deployment (PayPal token, AI budget, webhook ids, the cron's schedule,
* health facts). Both are caches, never sources of truth (§11 "Rebuild").
*
* Owner: reconciler workstream. Scaffold: the classes exist (deploy/wrangler.toml binds and migrates them) and expose no
* method yet; `durableStores` answers 501 `not-implemented` for every call.
*/
var Payee = class extends DurableObject {};
var Global = class extends DurableObject {};
/** The name of a payee's Durable Object: one per address, lowercase. */
const payeeObjectName = (address) => `payee:${address.toLowerCase()}`;
/** The name of the deployment's one Global Durable Object. */
const GLOBAL_OBJECT_NAME = "global";
/** The stores over the Durable Object stubs. */
function durableStores(env) {
	const pending = createMemoryStores();
	return {
		payee: (address) => {
			env.PAYEE.idFromName(payeeObjectName(address));
			return pending.payee(address);
		},
		global: () => {
			env.GLOBAL.idFromName(GLOBAL_OBJECT_NAME);
			return pending.global();
		}
	};
}

//#endregion
//#region apps/api/src/ai/models.ts
const PRIMARY_MODEL = {
	id: "@cf/google/gemma-4-26b-a4b-it",
	contextWindow: 256e3,
	neuronsPerMillion: {
		input: 9091,
		output: 27273
	},
	jsonSchema: "catalog",
	toolChoice: true
};
const FALLBACK_MODEL = {
	id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
	contextWindow: 24e3,
	neuronsPerMillion: {
		input: 26668,
		output: 204805
	},
	jsonSchema: "json-mode-page",
	toolChoice: false
};
/** Workers AI's free allocation per day (pricing page: "10,000 Neurons per day at no charge"). */
const FREE_NEURONS_PER_DAY = 1e4;

//#endregion
//#region apps/api/src/core/version.ts
/** The API's version, reported by `GET /v1/health` (test/smoke.test.ts keeps it equal to package.json). */
const API_VERSION = "0.1.0";

//#endregion
//#region apps/api/src/core/config.ts
/**
* The deployed API's configuration: code, not variables (a value here changes only with a reviewed commit). The Node
* entry overrides the origins and modes for tests, e2e and the offline demo.
*
* Owner: foundation.
*/
/**
* The PayPal edition's origins (decision D-HOST): the Cloudflare Pages preview of branch `paypal`, where the edition is
* served at /paypal/, and the production Pages origin, where it will be once merged.
*/
const PAGES_ORIGINS = ["https://paypal.paylink-mg.pages.dev", "https://paylink-mg.pages.dev"];
/** PayPal's sandbox REST base (`servers` of invoicing_v2.json and notifications_webhooks_v1.json at 90e8041, V). */
const PAYPAL_SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
const DEFAULT_CONFIG = {
	service: "paylink-api",
	version: API_VERSION,
	allowedOrigins: PAGES_ORIGINS,
	paypal: {
		mode: "sandbox",
		baseUrl: PAYPAL_SANDBOX_BASE,
		payerHost: null
	},
	ai: {
		mode: "workers-ai",
		model: PRIMARY_MODEL.id,
		fallbackModel: FALLBACK_MODEL.id,
		dailyNeuronBudget: FREE_NEURONS_PER_DAY,
		timeoutMs: 2e4
	},
	chainId: PAYPAL_EDITION_CHAIN_ID,
	quotas: {
		twinsPerDay: 20,
		aiCallsPerDay: 60
	}
};

//#endregion
//#region apps/api/src/worker/runtime.ts
/**
* The Worker's runtime, built once per isolate from its bindings and secrets (src/worker/index.ts). Kept out of the
* entry module because the platform treats every named export of the entry as an entrypoint.
*
* Owner: foundation.
*/
const sink = (line) => {
	console.log(line);
};
/** The runtime of this isolate, from its bindings and secrets. */
function workerRuntime(env) {
	const secrets = {
		...env.PAYPAL_CLIENT_ID === void 0 ? {} : { paypalClientId: env.PAYPAL_CLIENT_ID },
		...env.PAYPAL_CLIENT_SECRET === void 0 ? {} : { paypalClientSecret: env.PAYPAL_CLIENT_SECRET },
		...env.PAYPAL_WEBHOOK_ID === void 0 ? {} : { paypalWebhookId: env.PAYPAL_WEBHOOK_ID },
		...env.APPROVAL_HMAC_KEY === void 0 ? {} : { approvalHmacKey: env.APPROVAL_HMAC_KEY },
		...env.SESSION_HMAC_KEY === void 0 ? {} : { sessionHmacKey: env.SESSION_HMAC_KEY }
	};
	return {
		kind: "worker",
		config: DEFAULT_CONFIG,
		secrets,
		fetch: (input, init) => fetch(input, init),
		clock: () => Date.now(),
		random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
		logger: createLogger({
			sink,
			secrets: Object.values(secrets),
			base: {
				service: DEFAULT_CONFIG.service,
				version: DEFAULT_CONFIG.version
			}
		}),
		ai: env.AI
	};
}

//#endregion
//#region apps/api/src/worker/index.ts
/**
* Cloudflare Worker entry of `paylink-api` (decision D-HOST): `fetch` serves the Hono app, `scheduled` runs the one cron,
* and the Durable Object classes `Payee` and `Global` are exported for their bindings. The runtime is built once per
* isolate from the bindings and secrets; no secret value is ever logged (the logger scrubs every one it is given).
*
* Owner: foundation. Workstreams change their factories and src/worker/durable.ts, not this file.
*/
let isolate = null;
function forEnv(env) {
	if (isolate?.env !== env) {
		const services = createServices(workerRuntime(env), durableStores(env));
		isolate = {
			env,
			services,
			app: createApp(services)
		};
	}
	return isolate;
}
var worker_default = {
	fetch: (request, env, ctx) => forEnv(env).app.fetch(request, env, ctx),
	scheduled: (controller, env, ctx) => {
		const { services } = forEnv(env);
		ctx.waitUntil(runCron(services, controller.scheduledTime).then(() => void 0, (error) => {
			services.runtime.logger.log("error", "cron.failed", { errorName: error instanceof Error ? error.name : typeof error });
		}));
	}
};

//#endregion
export { Global, Payee, worker_default as default };