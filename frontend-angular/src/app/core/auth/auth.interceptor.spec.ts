import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { authInterceptor } from './auth.interceptor';
import { Tokens } from './auth.models';
import { TokenStorage } from './token-storage';

const API = 'http://localhost:3000/api';

/**
 * Doble en memoria. TokenStorage es el único punto que toca localStorage, así
 * que reemplazarlo acá deja los tests sin depender del DOM (y esquiva el
 * localStorage experimental a medias que Node 25 le encaja a jsdom).
 */
class InMemoryTokenStorage extends TokenStorage {
  private tokens: Tokens | null = null;

  override get accessToken(): string | null {
    return this.tokens?.accessToken ?? null;
  }

  override get refreshToken(): string | null {
    return this.tokens?.refreshToken ?? null;
  }

  override save(tokens: Tokens): void {
    this.tokens = tokens;
  }

  override clear(): void {
    this.tokens = null;
  }
}

describe('authInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let storage: TokenStorage;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        // El forceLogout del refresh fallido navega a /login: la ruta tiene que existir.
        provideRouter([{ path: 'login', children: [] }]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: TokenStorage, useClass: InMemoryTokenStorage },
      ],
    });

    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    storage = TestBed.inject(TokenStorage);
    storage.save({ accessToken: 'access-viejo', refreshToken: 'refresh-viejo' });
  });

  afterEach(() => {
    backend.verify();
  });

  it('agrega el access token a los requests', () => {
    http.get(`${API}/homes`).subscribe();

    const req = backend.expectOne(`${API}/homes`);
    expect(req.request.headers.get('Authorization')).toBe('Bearer access-viejo');
    req.flush([]);
  });

  it('no agrega token al login', () => {
    http.post(`${API}/auth/login`, {}).subscribe();

    const req = backend.expectOne(`${API}/auth/login`);
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({ accessToken: 'a', refreshToken: 'r' });
  });

  it('ante un 401 refresca y reintenta el request original con el token nuevo', () => {
    const respuestas: unknown[] = [];
    http.get(`${API}/homes`).subscribe((r) => respuestas.push(r));

    backend.expectOne(`${API}/homes`).flush(null, { status: 401, statusText: 'Unauthorized' });

    const refresh = backend.expectOne(`${API}/auth/refresh`);
    expect(refresh.request.body).toEqual({ refreshToken: 'refresh-viejo' });
    refresh.flush({ accessToken: 'access-nuevo', refreshToken: 'refresh-nuevo' });

    const reintento = backend.expectOne(`${API}/homes`);
    expect(reintento.request.headers.get('Authorization')).toBe('Bearer access-nuevo');
    reintento.flush([{ id: 1 }]);

    expect(respuestas).toEqual([[{ id: 1 }]]);
    // El refresh ROTA: hay que haber guardado los dos tokens nuevos.
    expect(storage.accessToken).toBe('access-nuevo');
    expect(storage.refreshToken).toBe('refresh-nuevo');
  });

  it('con N requests en 401 simultáneos dispara UN SOLO refresh', () => {
    http.get(`${API}/homes`).subscribe();
    http.get(`${API}/devices`).subscribe();
    http.get(`${API}/neighborhoods`).subscribe();

    for (const url of ['/homes', '/devices', '/neighborhoods']) {
      backend.expectOne(`${API}${url}`).flush(null, { status: 401, statusText: 'Unauthorized' });
    }

    // Si el interceptor fuera ingenuo, acá habría 3 refresh: el primero rota el
    // token y los otros 2 fallarían con el refresh ya quemado.
    const refreshes = backend.match(`${API}/auth/refresh`);
    expect(refreshes.length).toBe(1);
    refreshes[0].flush({ accessToken: 'access-nuevo', refreshToken: 'refresh-nuevo' });

    for (const url of ['/homes', '/devices', '/neighborhoods']) {
      const reintento = backend.expectOne(`${API}${url}`);
      expect(reintento.request.headers.get('Authorization')).toBe('Bearer access-nuevo');
      reintento.flush([]);
    }
  });

  it('si el refresh falla, limpia los tokens y no reintenta', () => {
    let fallo: unknown = null;
    http.get(`${API}/homes`).subscribe({ error: (e) => (fallo = e) });

    backend.expectOne(`${API}/homes`).flush(null, { status: 401, statusText: 'Unauthorized' });
    backend
      .expectOne(`${API}/auth/refresh`)
      .flush(null, { status: 401, statusText: 'Unauthorized' });

    expect(fallo).toBeTruthy();
    expect(storage.accessToken).toBeNull();
    expect(storage.refreshToken).toBeNull();
    backend.expectNone(`${API}/homes`);
  });
});
