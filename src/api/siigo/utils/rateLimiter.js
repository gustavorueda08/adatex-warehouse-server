"use strict";

/**
 * Rate Limiter para la API de Siigo
 *
 * La API de Siigo tiene un límite de 100 peticiones por minuto.
 * Este módulo implementa:
 * - Control de peticiones en ventana de tiempo móvil
 * - Cola de espera automática cuando se acerca al límite
 * - Tracking de peticiones realizadas
 */

class SiigoRateLimiter {
  constructor() {
    // Configuración desde variables de entorno
    this.maxRequests = parseInt(process.env.SIIGO_RATE_LIMIT || "95"); // 95 para margen de seguridad
    this.windowMs = 60 * 1000; // 1 minuto en milisegundos

    // Array que guarda los timestamps de las peticiones recientes
    this.requests = [];

    // Cola de promesas pendientes
    this.queue = [];
    this.processing = false;
  }

  /**
   * Limpia las peticiones antiguas fuera de la ventana de tiempo
   */
  cleanOldRequests() {
    const now = Date.now();
    const cutoffTime = now - this.windowMs;

    // Filtrar solo las peticiones dentro de la ventana de tiempo
    this.requests = this.requests.filter(timestamp => timestamp > cutoffTime);
  }

  /**
   * Obtiene el número de peticiones en la ventana actual
   */
  getRequestCount() {
    this.cleanOldRequests();
    return this.requests.length;
  }

  /**
   * Calcula cuánto tiempo esperar antes de la siguiente petición
   * @returns {number} Milisegundos a esperar
   */
  getWaitTime() {
    this.cleanOldRequests();

    const currentCount = this.requests.length;

    // Si estamos por debajo del límite, no hay que esperar
    if (currentCount < this.maxRequests) {
      return 0;
    }

    // Si estamos en el límite, calcular cuándo expira la petición más antigua
    const oldestRequest = this.requests[0];
    const timeToWait = (oldestRequest + this.windowMs) - Date.now();

    // Añadir 100ms de margen
    return Math.max(0, timeToWait + 100);
  }

  /**
   * Registra una nueva petición
   */
  recordRequest() {
    this.requests.push(Date.now());
  }

  /**
   * Espera hasta que sea seguro hacer una petición
   * @returns {Promise<void>}
   */
  async waitForSlot() {
    const waitTime = this.getWaitTime();

    if (waitTime > 0) {
      const currentCount = this.getRequestCount();
      console.log(
        `[Siigo Rate Limiter] Límite alcanzado (${currentCount}/${this.maxRequests} req/min). ` +
        `Esperando ${Math.ceil(waitTime / 1000)}s...`
      );

      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  /**
   * Ejecuta una función respetando el rate limit
   * @param {Function} fn - Función a ejecutar que retorna una Promise
   * @returns {Promise<any>} Resultado de la función
   */
  async execute(fn) {
    // Esperar si es necesario
    await this.waitForSlot();

    // Registrar la petición
    this.recordRequest();

    // Ejecutar la función
    return await fn();
  }

  /**
   * Obtiene estadísticas del rate limiter
   * @returns {Object} Estadísticas
   */
  getStats() {
    this.cleanOldRequests();
    return {
      requestsInWindow: this.requests.length,
      maxRequests: this.maxRequests,
      windowMs: this.windowMs,
      utilizationPercent: Math.round((this.requests.length / this.maxRequests) * 100),
      canMakeRequest: this.requests.length < this.maxRequests,
    };
  }

  /**
   * Resetea el rate limiter (útil para testing)
   */
  reset() {
    this.requests = [];
    this.queue = [];
    this.processing = false;
  }
}

// Exportar una instancia singleton
const rateLimiter = new SiigoRateLimiter();

module.exports = rateLimiter;
