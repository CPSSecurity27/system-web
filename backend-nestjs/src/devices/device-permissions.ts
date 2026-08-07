import { MembershipRequirement } from '../auth/decorators/roles.decorator';
import { AccountType, UserRole } from '../common/enums';

/**
 * Quién CONFIGURA un equipo, por rol. El otro eje —en qué barrio— lo resuelve
 * `assertManagesNeighborhood`: los dos son obligatorios.
 *
 * El MONITOR queda afuera a propósito: mira el tablero y resuelve eventos, no
 * toca la infraestructura. Apagar el módulo `rf` desde la pantalla de monitoreo
 * dejaría un poste sordo a los controles remotos sin que nadie lo note.
 *
 * Vive en su propio archivo —y no en el controlador— porque el servicio también
 * necesita la lista para responder `puedeEditar`. Con la constante en el
 * controlador, el import iría en círculo.
 */
export const CONFIGURAN_EQUIPOS: MembershipRequirement[] = [
  {
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  },
  {
    accountType: AccountType.ORGANIZATION,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  },
];

/**
 * Quién puede LEER las contraseñas WiFi en claro. Solo CPS y siempre auditado.
 *
 * Editar una red no requiere leerla (una red sin `psw` en el patch conserva la
 * del espejo), así que restringir la lectura no le saca capacidad a nadie: el
 * técnico municipal sigue pudiendo cambiar la clave de su propia red.
 */
export const VEN_PASSWORDS_WIFI: MembershipRequirement[] = [
  {
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  },
];

/**
 * Quién puede ACTUALIZAR EL FIRMWARE de un equipo. Solo CPS.
 *
 * Es más chico que `CONFIGURAN_EQUIPOS` y eso es un cambio deliberado: hasta el
 * 2026-08-06 el `cmd t:ota` entraba por la lista de arriba, así que un TECHNICIAN
 * o ADMIN de una ORGANIZATION podía mandar un OTA **con la URL que quisiera** a
 * sus postes. La única red era la allowlist del firmware, que garantiza el HOST
 * y no qué `.bin` hay del otro lado.
 *
 * El contrato con el GtD ya lo pedía —"los destructivos (`factory`, `ota`,
 * `restart`) exigen rol CPS, y se chequea adentro de `gtd.enqueue_command`
 * porque en el controller se puede olvidar"— y nunca se implementó en ninguno
 * de los dos lados. Se cierra con el catálogo de firmwares: quien carga los
 * binarios es quien los manda.
 *
 * `restart` y `factory` NO se tocaron: son mantenimiento del que opera el
 * barrio, y no instalan software nuevo. Y el otro eje sigue igual — el barrio se
 * valida con `assertManagesNeighborhood` como en cualquier otro comando.
 *
 * Vive acá y no en el módulo `firmware` porque el que la necesita es
 * `DeviceCommandsService`, y `firmware` ya importa a `devices`: al revés sería
 * un ciclo.
 */
export const ACTUALIZAN_FIRMWARE: MembershipRequirement[] = [
  {
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  },
];

/**
 * Quién puede DISPARAR o APAGAR la alarma a distancia.
 *
 * Es la única acción sobre el equipo que suma al MONITOR, y la razón es que no
 * es infraestructura: es la operación misma. El monitor es quien está mirando
 * el tablero a las tres de la mañana cuando entra un evento y quien tiene que
 * poder hacer sonar el barrio —o callarlo— sin buscar a un técnico.
 *
 * Sigue valiendo el otro eje: `assertManagesNeighborhood`. Un monitor de una
 * organización cuyo barrio lo opera CPS mira y no dispara.
 */
export const DISPARAN_ALARMA: MembershipRequirement[] = [
  {
    accountType: AccountType.COMPANY,
    roles: [
      UserRole.OWNER,
      UserRole.ADMIN,
      UserRole.TECHNICIAN,
      UserRole.MONITOR,
    ],
  },
  {
    accountType: AccountType.ORGANIZATION,
    roles: [
      UserRole.OWNER,
      UserRole.ADMIN,
      UserRole.TECHNICIAN,
      UserRole.MONITOR,
    ],
  },
];
