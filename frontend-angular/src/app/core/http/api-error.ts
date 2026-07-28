import { HttpErrorResponse } from '@angular/common/http';

/**
 * El `message` de un 400 puede ser un string O un array de strings (cuando
 * falla la validación de varios campos a la vez). Hay que manejar los dos.
 *
 * Los mensajes del backend ya vienen en castellano y son específicos: se
 * muestran tal cual. Solo se inventa texto cuando el backend no dio ninguno.
 */
export function apiErrorMessage(error: unknown): string {
  if (!(error instanceof HttpErrorResponse)) {
    return 'Ocurrió un error inesperado.';
  }

  const message = error.error?.message;

  if (Array.isArray(message)) {
    return message.join('. ');
  }
  if (typeof message === 'string' && message.length > 0) {
    return message;
  }

  switch (error.status) {
    case 0:
      return 'No se pudo conectar con el servidor. ¿Está levantado el backend?';
    case 401:
      return 'Usuario o contraseña incorrectos.';
    case 403:
      return 'No tenés acceso a este recurso.';
    case 404:
      return 'No se encontró lo que buscabas.';
    case 409:
      return 'La operación entra en conflicto con datos existentes.';
    default:
      return 'Ocurrió un error inesperado.';
  }
}
