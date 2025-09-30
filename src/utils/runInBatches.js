/**
 * Ejecuta funciones asíncronas con límite de concurrencia.
 * @param {Array} array - Elementos a procesar
 * @param {Function} asyncFn - Función asíncrona
 * @param {number} concurrency - Máximo de tareas simultáneas
 * @returns {Promise<Array>}
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
