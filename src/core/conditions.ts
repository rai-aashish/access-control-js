import { warnOnce } from "./dev";

/**
 * Three-valued outcome of judging a condition or clause.
 *
 * `unknown` is not the same as `no-match`: it means the context did not carry enough
 * information to decide. Keeping the two apart is what lets an undecidable deny be
 * reported rather than silently indistinguishable from one that provably does not apply.
 */
export type Judgement = "match" | "no-match" | "unknown";

/** Operators recognised inside a condition value. */
const OPERATOR_KEYS = new Set([
	"$eq",
	"$ne",
	"$in",
	"$nin",
	"$gt",
	"$gte",
	"$lt",
	"$lte",
	"$contains",
	"$exists",
	"$ref",
]);

type Resolved = { found: boolean; value: unknown };

const NOT_FOUND: Resolved = { found: false, value: undefined };

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A plain object literal, as opposed to a Map, Set, class instance or anything else
 * carrying behaviour. Only plain objects and arrays are compared by value.
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	if (!isPlainRecord(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
};

/**
 * How deep value comparison and cache keys look. Anything deeper compares unequal and is
 * treated as uncacheable, so the two stay consistent — and cycles stay safe.
 */
const MAX_VALUE_DEPTH = 8;

/**
 * Structural equality for conditions.
 *
 * Primitives compare with `===` and Dates by timestamp. Plain objects and arrays compare
 * recursively, because a policy is serializable: one loaded as JSON can never share an
 * object reference with a runtime context, so comparing those by reference could only
 * ever be false. Everything else — Map, Set, class instances, functions — keeps reference
 * semantics, since this library cannot know what equality should mean for them.
 */
export const deepEquals = (a: unknown, b: unknown, depth = 0): boolean => {
	if (a === b) return true;
	if (a instanceof Date && b instanceof Date) {
		return a.getTime() === b.getTime();
	}
	if (depth >= MAX_VALUE_DEPTH) return false;

	if (Array.isArray(a) && Array.isArray(b)) {
		return (
			a.length === b.length &&
			a.every((entry, i) => deepEquals(entry, b[i], depth + 1))
		);
	}

	if (isPlainObject(a) && isPlainObject(b)) {
		const aKeys = Object.keys(a);
		return (
			aKeys.length === Object.keys(b).length &&
			aKeys.every((k) => k in b && deepEquals(a[k], b[k], depth + 1))
		);
	}

	return false;
};

/**
 * Encodes a value for a result-cache key, or returns `null` when it cannot be keyed
 * faithfully.
 *
 * Faithful means two values `deepEquals` calls equal encode alike, and two it calls
 * different encode differently. Primitives, Dates, plain objects and arrays all qualify.
 * Anything compared by reference does not — a serialized key cannot tell two instances
 * apart — so it makes the whole context uncacheable. This sits next to `deepEquals` on
 * purpose: if one gains a case, the other has to.
 */
export const encodeValueForKey = (value: unknown, depth = 0): string | null => {
	if (value === null) return "null";
	if (value === undefined) return "undefined";

	const type = typeof value;
	if (
		type === "string" ||
		type === "number" ||
		type === "boolean" ||
		type === "bigint"
	) {
		// The type tag keeps 1 and "1" apart, as `===` does
		return `${type}:${JSON.stringify(String(value))}`;
	}

	if (value instanceof Date) return `date:${value.getTime()}`;

	// Past the depth deepEquals inspects, distinct values could encode alike
	if (depth >= MAX_VALUE_DEPTH) return null;

	if (Array.isArray(value)) {
		const parts: string[] = [];
		for (const entry of value) {
			const encoded = encodeValueForKey(entry, depth + 1);
			if (encoded === null) return null;
			parts.push(encoded);
		}
		return `[${parts.join(",")}]`;
	}

	if (isPlainObject(value)) {
		const parts: string[] = [];
		// Sorted, so {role,id} and {id,role} produce one key
		for (const k of Object.keys(value).sort()) {
			const encoded = encodeValueForKey(value[k], depth + 1);
			if (encoded === null) return null;
			parts.push(`${JSON.stringify(k)}:${encoded}`);
		}
		return `{${parts.join(",")}}`;
	}

	return null;
};

/**
 * Reads a dot path out of a context, e.g. `"user.id"`. Reports whether the path was
 * present at all, so a missing path can be judged `unknown` rather than compared
 * against `undefined`.
 */
const resolvePath = (
	context: Record<string, unknown>,
	path: string,
): Resolved => {
	if (!path.includes(".")) {
		return path in context ? { found: true, value: context[path] } : NOT_FOUND;
	}

	let current: unknown = context;
	for (const segment of path.split(".")) {
		if (current === null || typeof current !== "object") return NOT_FOUND;
		const record = current as Record<string, unknown>;
		if (!(segment in record)) return NOT_FOUND;
		current = record[segment];
	}
	return { found: true, value: current };
};

/**
 * Whether a condition value is an operator spec rather than a literal to compare.
 * A spec is a plain object whose every key starts with `$`; anything else — including
 * `{}` and objects mixing `$` and plain keys — is treated as a literal value.
 */
const isOperatorSpec = (value: unknown): value is Record<string, unknown> => {
	if (!isPlainRecord(value)) return false;
	const keys = Object.keys(value);
	return keys.length > 0 && keys.every((k) => k.startsWith("$"));
};

/** `{ $ref: "user.id" }` used as an operand, rather than as an operator. */
const isRefOperand = (value: unknown): value is { $ref: string } =>
	isPlainRecord(value) &&
	Object.keys(value).length === 1 &&
	typeof value.$ref === "string";

/** Resolves an operand, following a `{ $ref }` into the context when present. */
const resolveOperand = (
	operand: unknown,
	context: Record<string, unknown>,
): Resolved =>
	isRefOperand(operand)
		? resolvePath(context, operand.$ref)
		: { found: true, value: operand };

/** Values that can be ordered. Dates order by timestamp. */
const toComparable = (value: unknown): number | bigint | string | null => {
	if (value instanceof Date) return value.getTime();
	if (
		typeof value === "number" ||
		typeof value === "bigint" ||
		typeof value === "string"
	) {
		return value;
	}
	return null;
};

/** Compares two values of the same primitive kind. Returns null for mixed kinds. */
const compareSameKind = (
	left: number | bigint | string,
	right: number | bigint | string,
): number | null => {
	if (typeof left === "string" && typeof right === "string") {
		return left < right ? -1 : left > right ? 1 : 0;
	}
	if (typeof left === "number" && typeof right === "number") {
		return left < right ? -1 : left > right ? 1 : 0;
	}
	if (typeof left === "bigint" && typeof right === "bigint") {
		return left < right ? -1 : left > right ? 1 : 0;
	}
	return null;
};

const judgeOrdering = (
	operator: string,
	target: unknown,
	operand: unknown,
	path: string,
): Judgement => {
	const left = toComparable(target);
	const right = toComparable(operand);

	if (left === null || right === null) {
		warnOnce(
			`${operator} at "${path}" needs numbers, strings, bigints or Dates on both sides.`,
		);
		return "no-match";
	}

	const order = compareSameKind(left, right);
	if (order === null) {
		warnOnce(
			`${operator} at "${path}" compared values of different kinds, which never matches.`,
		);
		return "no-match";
	}

	const holds =
		operator === "$gt"
			? order > 0
			: operator === "$gte"
				? order >= 0
				: operator === "$lt"
					? order < 0
					: order <= 0;
	return holds ? "match" : "no-match";
};

const judgeContains = (
	target: unknown,
	operand: unknown,
	path: string,
): Judgement => {
	if (typeof target === "string") {
		if (typeof operand !== "string") {
			warnOnce(`$contains at "${path}" needs a string to look for.`);
			return "no-match";
		}
		return target.includes(operand) ? "match" : "no-match";
	}

	if (Array.isArray(target)) {
		return target.some((entry) => deepEquals(entry, operand))
			? "match"
			: "no-match";
	}

	warnOnce(`$contains at "${path}" needs a string or an array in the context.`);
	return "no-match";
};

const judgeOperator = (
	operator: string,
	rawOperand: unknown,
	target: Resolved,
	context: Record<string, unknown>,
	path: string,
): Judgement => {
	// The one operator that is decidable when the path is absent — that is its purpose
	if (operator === "$exists") {
		if (typeof rawOperand !== "boolean") {
			warnOnce(`$exists at "${path}" needs true or false.`);
			return "no-match";
		}
		return target.found === rawOperand ? "match" : "no-match";
	}

	// `{ field: { $ref: "user.id" } }` is shorthand for an equality against that path
	if (operator === "$ref") {
		if (typeof rawOperand !== "string") {
			warnOnce(`$ref at "${path}" needs a context path as a string.`);
			return "no-match";
		}
		const referenced = resolvePath(context, rawOperand);
		if (!referenced.found || !target.found) return "unknown";
		return deepEquals(target.value, referenced.value) ? "match" : "no-match";
	}

	if (!OPERATOR_KEYS.has(operator)) {
		warnOnce(
			`Unknown operator ${operator} at "${path}", so the condition never matches.`,
		);
		return "no-match";
	}

	const operand = resolveOperand(rawOperand, context);
	// Either side missing leaves the comparison undecided
	if (!operand.found || !target.found) return "unknown";

	switch (operator) {
		case "$eq":
			return deepEquals(target.value, operand.value) ? "match" : "no-match";
		case "$ne":
			return deepEquals(target.value, operand.value) ? "no-match" : "match";
		case "$in":
		case "$nin": {
			if (!Array.isArray(operand.value)) {
				warnOnce(`${operator} at "${path}" needs an array to compare against.`);
				return "no-match";
			}
			const isMember = operand.value.some((entry) =>
				deepEquals(entry, target.value),
			);
			const holds = operator === "$in" ? isMember : !isMember;
			return holds ? "match" : "no-match";
		}
		case "$contains":
			return judgeContains(target.value, operand.value, path);
		default:
			return judgeOrdering(operator, target.value, operand.value, path);
	}
};

/** Judges one `path: value` clause of a condition. Several operators on one path are ANDed. */
const judgeClause = (
	path: string,
	spec: unknown,
	context: Record<string, unknown>,
): Judgement => {
	const target = resolvePath(context, path);

	if (!isOperatorSpec(spec)) {
		// A bare value is sugar for $eq
		if (!target.found) return "unknown";
		return deepEquals(target.value, spec) ? "match" : "no-match";
	}

	let sawUnknown = false;
	for (const [operator, rawOperand] of Object.entries(spec)) {
		const judgement = judgeOperator(
			operator,
			rawOperand,
			target,
			context,
			path,
		);
		// A definite failure settles the whole clause, unknowns notwithstanding
		if (judgement === "no-match") return "no-match";
		if (judgement === "unknown") sawUnknown = true;
	}
	return sawUnknown ? "unknown" : "match";
};

/**
 * Judges a whole condition against one context. Clauses are ANDed, three-valued:
 * one definite failure makes the condition `no-match` even if another clause is
 * `unknown`, because false AND unknown is false.
 */
export const judgeCondition = (
	condition: Record<string, unknown>,
	context: Record<string, unknown>,
): Judgement => {
	let sawUnknown = false;
	for (const [path, spec] of Object.entries(condition)) {
		const judgement = judgeClause(path, spec, context);
		if (judgement === "no-match") return "no-match";
		if (judgement === "unknown") sawUnknown = true;
	}
	return sawUnknown ? "unknown" : "match";
};
