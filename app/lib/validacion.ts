// Límites de entrada compartidos entre el backend y los formularios del panel.
// Viven aquí para que el maxLength del input y el recorte del servidor no se
// desincronicen (antes cada archivo repetía su propia constante con el mismo valor).

// Número de venta / comanda que teclea el cajero o corrige el administrador
export const LONGITUD_MAX_COMANDA = 60;

// Término del buscador de la auditoría
export const LONGITUD_MAX_BUSQUEDA = 60;

// PIN del panel administrativo. El tope estaba fijado a 4 en el input, así que por
// mucho que se configurara un ADMIN_PIN más largo nadie podía teclearlo y el servidor
// avisaba en cada petición de que el PIN era corto. 4 dígitos son 10.000 combinaciones;
// con 12 el espacio queda holgado y el límite deja de ser el formulario.
export const LONGITUD_MAX_PIN = 12;
