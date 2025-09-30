class ApiError extends Error {
  constructor(status = 500, message = "Error") {
    super(message);
    this.status = status;
  }
}
module.exports = ApiError;
