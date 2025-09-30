// validation/withValidation.js
const withValidation = (schema, handler) => async (input) => {
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    const err = new Error(
      parsed.error.issues
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(" | ")
    );
    throw err;
  }
  return handler(parsed.data);
};

module.exports = { withValidation };
