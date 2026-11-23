import { validationError } from './errors.js';

const PARTS = ['params', 'query', 'body'];

/**
 * Validate request parts with Zod schemas and expose the parsed values as `req.valid`.
 * All parts are checked so the client gets every problem in one response (422).
 * @param {{ params?: import('zod').ZodType, query?: import('zod').ZodType, body?: import('zod').ZodType }} schemas
 */
export function validate(schemas) {
  return function validateRequest(req, _res, next) {
    const valid = {};
    const issues = [];
    for (const part of PARTS) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (result.success) valid[part] = result.data;
      else issues.push(...result.error.issues.map((issue) => ({ ...issue, path: [part, ...issue.path] })));
    }
    if (issues.length > 0) throw validationError(issues);
    req.valid = valid;
    next();
  };
}
