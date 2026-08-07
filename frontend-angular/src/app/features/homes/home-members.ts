import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import { DevicesService } from '../../core/api/devices.service';
import { HomesService } from '../../core/api/homes.service';
import { AuthService } from '../../core/auth/auth.service';
import { HomeMemberRole } from '../../core/auth/auth.models';
import { apiErrorMessage } from '../../core/http/api-error';
import { Device, Home, HomeMember } from '../../core/models/api.models';
import { Map, MapMarker } from '../../shared/map/map';

/**
 * Los MIEMBROS del hogar (nuevo en v2): un TITULAR y sus FAMILIARES, hasta el
 * cupo del barrio. Reemplaza a las cuentas HOME del modelo viejo.
 *
 * v2.3 (2026-08-02): el vecino se crea con NOMBRE + DNI — el DNI es su
 * identidad de login en la app. El email quedó como dato opcional (si está,
 * le llega un mail de activación como atajo). Nace sin contraseña: la fija él
 * la primera vez, y hasta entonces la lista lo muestra "sin activar".
 *
 * El alta es UNA sola llamada (`addPerson`): la persona y la membresía se
 * crean juntas en el backend, en una transacción. Las reglas duras (titular
 * único, una persona una casa, cupo, titular no borrable) las impone el
 * backend — acá solo se muestran sus mensajes.
 */
@Component({
  selector: 'app-home-members',
  imports: [ReactiveFormsModule, RouterLink, Map],
  templateUrl: './home-members.html',
})
export class HomeMembers {
  private readonly homes = inject(HomesService);
  private readonly devices = inject(DevicesService);
  private readonly route = inject(ActivatedRoute);
  private readonly fb = inject(FormBuilder);
  protected readonly auth = inject(AuthService);

  protected readonly id = Number(this.route.snapshot.paramMap.get('id'));

  protected readonly home = signal<Home | null>(null);
  protected readonly members = signal<HomeMember[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly titular = computed(
    () => this.members().find((m) => m.role === 'TITULAR') ?? null,
  );
  protected readonly hasTitular = computed(() => this.titular() !== null);

  /** Datos opcionales plegados: el alta normal es nombre + DNI y listo. */
  protected readonly verOpcionales = signal(false);

  // ── La alarma preferida ──────────────────────────────────────────────
  //
  // Hasta acá solo se podía elegir AL CREAR la vivienda, y una casa cargada
  // antes de que el barrio tuviera alarmas quedaba en `null` para siempre —
  // con la consecuencia de que **sus controles no se cargan en ningún panel**,
  // en silencio. Encontrado en producción el 2026-08-06.

  /** Las alarmas del barrio, ordenadas por cercanía a esta casa. */
  protected readonly alarmasDelBarrio = signal<Device[]>([]);
  protected readonly guardandoAlarma = signal(false);

  protected readonly alarmasCercanas = computed(() => {
    const casa = this.home();
    if (!casa) return [];
    return this.alarmasDelBarrio()
      .map((device) => ({
        device,
        metros:
          device.latitude !== null && device.longitude !== null
            ? metrosEntre(casa.latitude, casa.longitude, device.latitude, device.longitude)
            : null,
      }))
      .sort((a, b) => (a.metros ?? Infinity) - (b.metros ?? Infinity));
  });

  protected distancia(metros: number | null): string {
    if (metros === null) return 'sin coordenadas';
    return metros < 1000 ? `a ${Math.round(metros)} m` : `a ${(metros / 1000).toFixed(1)} km`;
  }

  /**
   * Cambia a qué alarma responde la casa. `null` = sin preferencia.
   *
   * OJO con lo que arrastra: los controles de esta casa se cargan en el panel
   * que ella elija, así que cambiarla deja al panel viejo con códigos que ya no
   * le corresponden (una baja pendiente) y al nuevo con altas por hacer. La
   * pantalla de la alarma lo va a mostrar solo.
   */
  protected cambiarAlarma(valor: string): void {
    if (this.guardandoAlarma()) return;

    const id = valor === '' ? null : Number(valor);
    this.guardandoAlarma.set(true);
    this.errorUbicacion.set(null);

    this.homes.update(this.id, { defaultDeviceId: id }).subscribe({
      next: (home) => {
        this.home.set(home);
        this.guardandoAlarma.set(false);
        this.avisoUbicacion.set(
          id === null
            ? 'La casa quedó sin alarma preferida: sus controles no se van a cargar en ningún equipo.'
            : 'Listo. Ahora hay que cargar sus controles desde la pestaña Configuración de esa alarma.',
        );
      },
      error: (err) => {
        // 400: la alarma tiene que ser del mismo barrio que la vivienda.
        this.errorUbicacion.set(apiErrorMessage(err));
        this.guardandoAlarma.set(false);
      },
    });
  }

  // ── Dónde está la casa ───────────────────────────────────────────────
  //
  // El GPS de la vivienda es OBLIGATORIO y se carga al darla de alta, pero
  // hasta acá no había forma de corregirlo: un pin mal puesto quedaba mal para
  // siempre. Y no es un dato decorativo — sale en el mapa del monitoreo y viaja
  // en el `gps` de cada evento, así que un error manda al móvil a otra cuadra.
  //
  // Calcado de la pestaña Instalación de la alarma, que resuelve exactamente lo
  // mismo: se hace click en el mapa, se ve el punto nuevo y recién ahí se guarda.

  /** Ubicación elegida clickeando el mapa, todavía sin guardar. */
  protected readonly nuevaUbicacion = signal<{
    latitude: number;
    longitude: number;
  } | null>(null);
  protected readonly guardandoUbicacion = signal(false);
  protected readonly errorUbicacion = signal<string | null>(null);
  protected readonly avisoUbicacion = signal<string | null>(null);

  protected readonly markers = computed<MapMarker[]>(() => {
    const home = this.home();
    if (!home) return [];
    const nueva = this.nuevaUbicacion();
    return [
      {
        latitude: nueva?.latitude ?? home.latitude,
        longitude: nueva?.longitude ?? home.longitude,
        label: home.address,
        variant: 'home',
      },
    ];
  });

  protected readonly centroMapa = computed<[number, number]>(() => {
    const home = this.home();
    // La casa SIEMPRE tiene coordenadas (son NOT NULL): no hay caso "sin punto"
    // como en la alarma, que puede estar en stock. Córdoba es solo el default
    // del componente mientras carga.
    return home ? [home.latitude, home.longitude] : [-31.4167, -64.1836];
  });

  /**
   * Quién corrige el punto: quien gestiona el barrio, y el TITULAR de ESTA casa.
   *
   * Es el mismo conjunto que acepta `PATCH /homes/:id` (`assertCanManageHome`).
   * Ojo con `auth.isTitular()` a secas: dice que sos titular de ALGUNA casa, no
   * de esta — usarlo acá le daría el botón al titular de la casa de enfrente.
   */
  protected readonly puedeEditarUbicacion = computed(
    () =>
      this.auth.isManager() ||
      (this.auth.user()?.homeMemberships ?? []).some(
        (h) => h.homeId === this.id && h.role === 'TITULAR',
      ),
  );

  /**
   * Alta de vecino + membresía en UNA llamada: nombre + DNI (su login),
   * el resto opcional. Sin contraseña: la fija el vecino.
   */
  protected readonly form = this.fb.nonNullable.group({
    name: ['', Validators.required],
    dni: ['', [Validators.required, Validators.pattern(/^\d{7,9}$/)]],
    telephone: [''],
    birthDate: [''],
    email: ['', Validators.email],
    role: ['FAMILIAR' as HomeMemberRole, Validators.required],
  });

  constructor() {
    this.load();
  }

  private load(): void {
    this.loading.set(true);

    forkJoin({
      home: this.homes.get(this.id),
      members: this.homes.members(this.id),
    }).subscribe({
      next: ({ home, members }) => {
        this.home.set(home);
        this.members.set(members);
        // Las alarmas del barrio, para poder elegir la preferida.
        this.devices.list(home.neighborhoodId).subscribe({
          next: (ds) => this.alarmasDelBarrio.set(ds),
          error: () => this.alarmasDelBarrio.set([]),
        });
        // El primer miembro de una casa vacía es, naturalmente, el titular.
        if (!members.some((m) => m.role === 'TITULAR')) {
          this.form.controls.role.setValue('TITULAR');
        }
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.loading.set(false);
      },
    });
  }

  private reloadMembers(): void {
    this.homes.members(this.id).subscribe((members) => this.members.set(members));
  }

  protected addMember(): void {
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    const value = this.form.getRawValue();

    this.saving.set(true);
    this.error.set(null);

    // UNA llamada: el backend crea la persona y la membresía en la misma
    // transacción. Antes eran dos, y un fallo en la segunda dejaba un vecino
    // suelto en el padrón sin casa.
    this.homes
      .addPerson(
        this.id,
        {
          name: value.name.trim(),
          dni: value.dni.trim(),
          telephone: value.telephone.trim() || undefined,
          birthDate: value.birthDate.trim() || undefined,
          email: value.email.trim() || undefined,
        },
        value.role,
      )
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.form.reset({
            name: '',
            dni: '',
            telephone: '',
            birthDate: '',
            email: '',
            role: 'FAMILIAR',
          });
          this.reloadMembers();
        },
        error: (err) => {
          // 400 del cupo de familiares (mensaje comercial) o 409 de DNI ya
          // cargado en otra vivienda: se muestran tal cual, dicen dónde está.
          this.error.set(apiErrorMessage(err));
          this.saving.set(false);
        },
      });
  }

  protected toggleSuspension(member: HomeMember): void {
    if (this.saving()) return;

    const status = member.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';

    this.saving.set(true);
    this.error.set(null);

    this.homes.updateMemberStatus(this.id, member.userId, status).subscribe({
      next: () => {
        this.saving.set(false);
        this.reloadMembers();
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  /** Solo gestores: el backend valida; acá el botón ni se muestra al vecino. */
  protected makeTitular(member: HomeMember): void {
    if (member.role === 'TITULAR' || this.saving()) return;

    this.saving.set(true);
    this.error.set(null);

    this.homes.transferTitular(this.id, member.userId).subscribe({
      next: (members) => {
        this.saving.set(false);
        this.members.set(members);
      },
      error: (err) => {
        // 400 (suspendido) o 409 (ya es titular de otro hogar): tal cual.
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  protected removeMember(member: HomeMember): void {
    // Al TITULAR no se lo borra: se transfiere (operación pendiente).
    if (member.role === 'TITULAR' || this.saving()) return;

    this.saving.set(true);
    this.error.set(null);

    this.homes.removeMember(this.id, member.userId).subscribe({
      next: () => {
        this.saving.set(false);
        this.reloadMembers();
      },
      error: (err) => {
        this.error.set(apiErrorMessage(err));
        this.saving.set(false);
      },
    });
  }

  // ── Corregir dónde está la casa ──────────────────────────────────────

  protected setUbicacion(position: { latitude: number; longitude: number }): void {
    this.nuevaUbicacion.set(position);
    this.errorUbicacion.set(null);
    this.avisoUbicacion.set(null);
  }

  protected descartarUbicacion(): void {
    this.nuevaUbicacion.set(null);
    this.errorUbicacion.set(null);
  }

  /**
   * Guarda el punto nuevo. Va como PATCH de dos campos: lo demás de la vivienda
   * ni se toca.
   *
   * OJO con lo que esto NO hace: no revisa si la **alarma preferida** sigue
   * siendo la más cercana. Mover el pin unos metros no cambia nada, pero
   * corregir una casa que estaba cargada en la otra punta del barrio puede
   * dejarla apuntando a un poste lejano. La preferida se elige a mano al dar de
   * alta y se cambia igual: acá se avisa, no se decide por el gestor.
   */
  protected guardarUbicacion(): void {
    const nueva = this.nuevaUbicacion();
    if (!nueva || this.guardandoUbicacion()) return;

    this.guardandoUbicacion.set(true);
    this.errorUbicacion.set(null);

    this.homes.update(this.id, { latitude: nueva.latitude, longitude: nueva.longitude }).subscribe({
      next: (home) => {
        this.home.set(home);
        this.nuevaUbicacion.set(null);
        this.guardandoUbicacion.set(false);
        this.avisoUbicacion.set('Listo: la casa quedó en el punto nuevo.');
      },
      error: (err) => {
        // 403: ni gestionás el barrio ni sos el titular de esta casa.
        this.errorUbicacion.set(apiErrorMessage(err));
        this.guardandoUbicacion.set(false);
      },
    });
  }
}

/**
 * Distancia en metros por la fórmula del haversine. Alcanza y sobra para
 * ordenar postes dentro de un barrio, y evita traer una librería para esto.
 * Copiada del alta de vivienda, que hace exactamente lo mismo.
 */
function metrosEntre(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const rad = (grados: number) => (grados * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
