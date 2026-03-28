/**
 * @fileoverview Concurrency-limited async batch processor.
 *
 * Runs an async function over an array while keeping at most `concurrency`
 * Promises in-flight at the same time. Results are written to the same index
 * as the input element so the returned array mirrors the input order.
 *
 * Why not Promise.all? Promise.all launches every Promise at once. For large
 * arrays this can exhaust database connections or hit rate limits. This
 * utility acts as a sliding-window semaphore.
 *
 * @example
 * // Process up to 5 items concurrently
 * const results = await runInBatches(orderIds, fetchOrder, 5);
 */

/**
 * @template T, R
 * @param {T[]} array - Items to process.
 * @param {function(T): Promise<R>} asyncFn - Async function applied to each item.
 * @param {number} [concurrency=100] - Maximum number of simultaneous Promises.
 * @returns {Promise<R[]>} Resolves with results in input order.
 *   Rejects immediately if any invocation of `asyncFn` rejects.
 */
async function runInBatches(array, asyncFn, concurrency = 100) {
  const results = new Array(array.length);
  let index = 0;
  let active = 0;

  return new Promise((resolve, reject) => {
    function next() {
      if (index >= array.length && active === 0) return resolve(results);

      while (active < concurrency && index < array.length) {
        const currentIndex = index++;
        active++;

        asyncFn(array[currentIndex])
          .then((result) => {
            results[currentIndex] = result;
          })
          .catch(reject)
          .finally(() => {
            active--;
            next();
          });
      }
    }

    next();
  });
}

module.exports = runInBatches;
