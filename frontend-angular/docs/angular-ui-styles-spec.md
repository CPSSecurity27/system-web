# Guía de Diseño, Estilos y Librerías: Sistema de Monitoreo de Alarmas Comunitarias

Este documento especifica exclusivamente la configuración visual, paleta de colores, tipografías, librerías gráficas y layouts responsivos para el frontend. No incluye lógica de negocio ni estructuras rígidas de páginas, permitiendo flexibilidad en el desarrollo futuro de componentes.

---

## 1. Identidad Visual y Paleta de Colores

Para garantizar una operación eficiente en situaciones críticas (como emergencias vecinales), la UI se mantiene limpia, de alto contraste y libre de elementos distractores.

*   **Color de Fondo:** Blanco puro (`#ffffff`) para el fondo del dashboard, listas de control y formularios.
*   **Color de la Marca (Alerta/Acción):** Rojo Corporativo (`#d32f2f`). Se utiliza estrictamente para botones de acción crítica (ej. "Atender Alerta", "Disparar Sirena"), estados de emergencia activos y elementos clave de branding.
*   **Color de Fondo Secundario:** Gris ultra claro (`#f8f9fa`) para diferenciar zonas como la barra lateral (Sidebar) o contenedores de tarjetas inactivas.
*   **Colores de Estado:**
    *   **Emergencia Activa / Crítico:** `#d32f2f` (Rojo)
    *   **Soporte Técnico / Alerta Preventiva:** `#f57c00` (Naranja)
    *   **Sistema OK / Atendido:** `#388e3c` (Verde)
    *   **Texto Principal:** `#212529` (Gris oscuro)
    *   **Texto Secundario:** `#6c757d` (Gris medio)

---

## 2. Tipografía: Inter Sans-serif

La tipografía oficial es **Inter**, elegida por su alta legibilidad en pantallas de cualquier tamaño y resolución.

### Importación en `src/index.html`
Agrega la tipografía desde Google Fonts dentro de la etiqueta `<head>`:

```html
<!-- Tipografía Inter -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
```

---

## 3. Integración de Bootstrap y Bootstrap Icons

La estructura responsiva y los componentes interactivos básicos se maquetan usando **Bootstrap 5** y su set oficial de iconos vectoriales.

### Importación de Bootstrap Icons (`src/index.html`)
Para un uso inmediato y ligero:

```html
<!-- Bootstrap Icons CDN -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">
```

### Configuración de Estilos Globales (`src/styles.css` o `src/styles.scss`)
Define las variables y overrides globales de Bootstrap para adaptarlos a la marca:

```css
/* Aplicación de Tipografía Global */
body {
  font-family: 'Inter', sans-serif;
  background-color: #ffffff;
  color: #212529;
  overflow-x: hidden;
}

/* --- CLASES DE ESTILO PERSONALIZADAS --- */

/* Botón con el color corporativo */
.btn-brand {
  background-color: #d32f2f;
  color: #ffffff;
  border: 1px solid #d32f2f;
  font-weight: 500;
  transition: background-color 0.2s ease-in-out;
}

.btn-brand:hover, .btn-brand:focus {
  background-color: #b71c1c;
  border-color: #b71c1c;
  color: #ffffff;
}

/* Botón secundario para acciones no críticas */
.btn-outline-brand {
  background-color: transparent;
  color: #d32f2f;
  border: 1px solid #d32f2f;
  font-weight: 500;
}

.btn-outline-brand:hover {
  background-color: #ffebee;
  color: #b71c1c;
  border-color: #b71c1c;
}

/* Textos y Bordes Corporativos */
.text-brand {
  color: #d32f2f !important;
}

.border-brand {
  border-color: #d32f2f !important;
}

/* Fondos atenuados para contenedores de alertas */
.bg-brand-soft {
  background-color: #ffebee !important; /* Rojo muy suave */
}

.bg-success-soft {
  background-color: #e8f5e9 !important; /* Verde suave */
}

.bg-warning-soft {
  background-color: #fff3e0 !important; /* Naranja suave */
}

/* Animación de pulso para llamadas de emergencia activas */
@keyframes pulse-red {
  0% {
    box-shadow: 0 0 0 0 rgba(211, 47, 47, 0.7);
  }
  70% {
    box-shadow: 0 0 0 10px rgba(211, 47, 47, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(211, 47, 47, 0);
  }
}

.animate-pulse-emergency {
  animation: pulse-red 2s infinite;
}
```

---

## 4. Configuración de Leaflet (Librería de Mapas)

Al utilizar Leaflet como solución de mapas Open Source, se requiere incluir sus hojas de estilos para que el contenedor del mapa renderice correctamente sus controles sin romper la responsividad.

### Importación de Estilos de Leaflet (`src/index.html`)
Agrega la siguiente línea en la sección `<head>`:

```html
<!-- Leaflet Map CSS -->
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" 
      integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" 
      crossorigin="" />
```

### Clase de Adaptabilidad para el Mapa (`src/styles.css`)
Garantiza que el mapa use el 100% de su contenedor responsivo:

```css
/* Contenedor del Mapa */
.map-viewport {
  width: 100%;
  height: 100%;
  min-height: 350px;
  max-height: 600px;
  border-radius: 8px;
  z-index: 1; /* Previene superposiciones con modales o dropdowns de Bootstrap */
}
```

---

## 5. Plantilla de Layout Responsiva y Directa

A continuación se presenta un patrón estructural recomendado utilizando clases de utilidad de Bootstrap. Está pensado para dar un aspecto de consola/dashboard a la pantalla del operador.

```html
<!-- Layout del Operador (Responsivo con barra lateral ocultable) -->
<div class="d-flex" id="wrapper" style="min-height: 100vh;">
  
  <!-- Sidebar (Gris claro) -->
  <aside class="bg-light border-end d-none d-md-block" style="width: 250px;" id="sidebar-wrapper">
    <div class="sidebar-heading border-bottom p-3 d-flex align-items-center">
      <i class="bi bi-shield-fill text-brand fs-4 me-2"></i>
      <span class="fw-bold">Monitoreo Urbano</span>
    </div>
    <div class="list-group list-group-flush p-2">
      <!-- Navegación sin estilos de lista pesados -->
      <a class="list-group-item list-group-item-action border-0 py-2.5 rounded text-dark" href="#">
        <i class="bi bi-speedometer2 me-2"></i> Dashboard
      </a>
      <a class="list-group-item list-group-item-action border-0 py-2.5 rounded text-dark" href="#">
        <i class="bi bi-people me-2"></i> Vecinos
      </a>
      <a class="list-group-item list-group-item-action border-0 py-2.5 rounded text-dark" href="#">
        <i class="bi bi-broadcast me-2"></i> Sirenas / Alarmas
      </a>
    </div>
  </aside>

  <!-- Contenedor Principal (Fondo Blanco) -->
  <div id="page-content-wrapper" class="flex-grow-1" style="background-color: #ffffff;">
    
    <!-- Navbar Superior -->
    <nav class="navbar navbar-expand-lg navbar-light bg-white border-bottom py-3">
      <div class="container-fluid">
        <!-- Botón alternador para móviles -->
        <button class="btn btn-outline-secondary d-md-none me-2" id="sidebarToggle">
          <i class="bi bi-list"></i>
        </button>
        
        <span class="navbar-brand fw-semibold text-brand mb-0 h1">Sistema de Alarmas</span>
        
        <div class="ms-auto d-flex align-items-center">
          <span class="me-3 text-muted d-none d-sm-inline-block small">
            <i class="bi bi-person-circle me-1"></i> Operador Activo
          </span>
          <button class="btn btn-sm btn-outline-danger">
            <i class="bi bi-box-arrow-right"></i>
          </button>
        </div>
      </div>
    </nav>

    <!-- Área de Contenido Dinámico (Vistas inyectadas aquí) -->
    <main class="container-fluid p-4">
      <!-- Aquí la IA de maquetación decidirá el flujo de componentes -->
    </main>
  </div>
</div>
```
