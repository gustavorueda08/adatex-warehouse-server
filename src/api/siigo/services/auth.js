"use strict";

/**
 * Servicio de autenticación con Siigo API
 * Maneja tokens OAuth con cache en memoria
 */

let tokenCache = {
  token: null,
  expiresAt: null,
};

module.exports = () => ({
  /**
   * Obtiene un token de acceso válido
   * Reutiliza token en cache si aún es válido
   */
  async getAccessToken() {
    try {
      // Modo test: retornar token falso
      if (process.env.SIIGO_TEST_MODE === "true") {
        return "test_token_" + Date.now();
      }

      // Verificar si hay token en cache y no ha expirado
      if (tokenCache.token && tokenCache.expiresAt) {
        const now = new Date().getTime();
        // Renovar 5 minutos antes de expirar
        if (now < tokenCache.expiresAt - 5 * 60 * 1000) {
          return tokenCache.token;
        }
      }

      // Obtener credenciales del entorno
      const username = process.env.SIIGO_USERNAME;
      const accessKey = process.env.SIIGO_ACCESS_KEY;
      const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";

      if (!username || !accessKey) {
        throw new Error(
          "Credenciales de Siigo no configuradas. Verifica SIIGO_USERNAME y SIIGO_ACCESS_KEY en .env"
        );
      }

      // Solicitar nuevo token
      const response = await fetch(`${apiUrl}/auth`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.SIIGO_SUBSCRIPTION_KEY && {
            "Ocp-Apim-Subscription-Key": process.env.SIIGO_SUBSCRIPTION_KEY,
          }),
        },
        body: JSON.stringify({
          username,
          access_key: accessKey,
        }),
      });

      if (!response.ok) {
        const errorData = await response.text();
        console.error("Error de Siigo:", errorData);
        throw new Error(
          `Error HTTP ${response.status}: ${response.statusText}`
        );
      }

      const data = await response.json();

      if (!data || !data.access_token) {
        throw new Error("Respuesta inválida de Siigo API al obtener token");
      }

      // Guardar en cache (token válido por 24 horas)
      tokenCache.token = data.access_token;
      const expiresIn = data.expires_in || 86400; // Default 24h en segundos
      tokenCache.expiresAt = new Date().getTime() + expiresIn * 1000;
      console.log("Nuevo token de Siigo obtenido exitosamente");
      return tokenCache.token;
    } catch (error) {
      console.error("Error al obtener token de Siigo:", error.message);
      throw new Error(`Error de autenticación con Siigo: ${error.message}`);
    }
  },

  /**
   * Invalida el token en cache
   * Útil para forzar renovación
   */
  invalidateToken() {
    tokenCache = {
      token: null,
      expiresAt: null,
    };
  },

  /**
   * Obtiene headers de autenticación para requests
   */
  async getAuthHeaders() {
    const token = await this.getAccessToken();
    return {
      Authorization: token,
      "Content-Type": "application/json",
      ...(process.env.SIIGO_SUBSCRIPTION_KEY && {
        "Ocp-Apim-Subscription-Key": process.env.SIIGO_SUBSCRIPTION_KEY,
      }),
    };
  },
});
