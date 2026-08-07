/**
 * Producción: `system.cpssecurity.com.ar`.
 *
 * La API va por ruta RELATIVA, no por una URL absoluta. El front y el backend se
 * sirven desde el MISMO origen —nginx manda `/api` a `localhost:3000` y el resto
 * al `index.html`—, así que:
 *
 * - no hay CORS de por medio (el navegador ni pregunta),
 * - el backend no queda expuesto en un puerto propio a internet,
 * - y el día que cambie el dominio no hay que recompilar el front.
 */
export const environment = {
  production: true,
  apiUrl: '/api',
};
