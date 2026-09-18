# Zeus — Checklist de pruebas funcionales reales

## Preparación

- [ ] Usar un bot de pruebas y un grupo de pruebas.
- [ ] Confirmar que el bot tenga permisos suficientes: borrar mensajes, restringir usuarios, expulsar/banear y administrar el grupo según las pruebas.
- [ ] Confirmar que Zeus tenga configurados `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` en el entorno de pruebas.
- [ ] Confirmar que la migración 008 haya sido revisada y aplicada únicamente en la base de pruebas autorizada.
- [ ] Usar dos cuentas de Telegram: la cuenta bootstrap/owner inicial y una cuenta nueva para recuperación.
- [ ] Guardar evidencias de cada prueba: captura de Telegram, hora, grupo, usuario y resultado.

## Zeus y System Owner

### Bootstrap

- [ ] Desde el chat privado, ejecutar `/zeus-bootstrap` con el Telegram ID configurado en `SYSTEM_OWNER_BOOTSTRAP_ID`.
- [ ] Confirmar que se crea el primer System Owner.
- [ ] Confirmar que el bot responde con éxito.
- [ ] Ejecutar `/zeus-bootstrap` otra vez y confirmar que no reemplaza al propietario.
- [ ] Ejecutar `/zeus-bootstrap` desde un grupo y confirmar que se rechaza.
- [ ] Ejecutar `/zeus-bootstrap` desde una cuenta distinta y confirmar que se rechaza.
- [ ] Confirmar que el bootstrap no autoriza automáticamente ningún grupo.

### Recovery Key

- [ ] Como System Owner, ejecutar `/zeus-generar-recuperacion`.
- [ ] Confirmar que la clave se muestra una sola vez en el chat privado.
- [ ] Confirmar que el secreto original no se vuelve a mostrar.
- [ ] Desde una cuenta nueva, ejecutar `/zeus-recuperar` o usar `Ayuda → Recovery Key → Recuperar System Owner`.
- [ ] Introducir la Recovery Key correcta.
- [ ] Confirmar que la cuenta nueva pasa a ser System Owner.
- [ ] Confirmar que la cuenta anterior deja de ser System Owner.
- [ ] Confirmar que la Recovery Key queda consumida.
- [ ] Repetir la recuperación con la misma clave y confirmar el rechazo.
- [ ] Intentar recuperar con una clave incorrecta y confirmar el rechazo.
- [ ] Intentar recuperar con una clave revocada y confirmar el rechazo.
- [ ] Generar un challenge y dejarlo expirar; confirmar que el RPC rechaza el challenge expirado.
- [ ] Generar dos challenges para la misma clave y confirmar que el segundo invalida el primero.
- [ ] Ejecutar varios intentos fallidos con la misma cuenta y confirmar que se activa el bloqueo de rate limit.
- [ ] Intentar recuperar mientras la cuenta está bloqueada y confirmar que no se consulta/consume ninguna clave.
- [ ] Tras una recuperación correcta, confirmar que el contador de fallos se limpia.
- [ ] Confirmar en auditoría `RECOVERY_GENERATED`, `RECOVERY_REJECTED`, `RECOVERY_CONSUMED` y `SYSTEM_OWNER_CHANGED` donde corresponda.

## Grupos y autorización Telegram

- [ ] El creator del grupo ejecuta `/menu`.
- [ ] Confirmar que el creator puede abrir el panel privado.
- [ ] Un usuario con estado `administrator` ejecuta `/menu`.
- [ ] Confirmar que el administrador puede abrir el panel privado.
- [ ] Un usuario normal ejecuta `/menu`.
- [ ] Confirmar que se rechaza y que el mensaje se elimina según la política actual.
- [ ] Quitar temporalmente al bot permisos de administración.
- [ ] Confirmar que el grupo deja de aparecer como administrable o que la operación se rechaza.
- [ ] Confirmar que System Owner no obtiene acceso a un grupo donde no es `creator`/`administrator`.
- [ ] Confirmar que Recovery Key no autoriza grupos.

## Panel privado

- [ ] Abrir `Usuarios`: listar usuarios observados, buscar un usuario y ejecutar una acción de moderación.
- [ ] Abrir `Seguridad Cerbero`: consultar estado, estadísticas y eventos.
- [ ] Abrir `Filtros`: listar, agregar, eliminar y activar/desactivar filtros.
- [ ] Abrir `Bienvenida`: activar/desactivar, editar, previsualizar y probar el mensaje.
- [ ] Abrir `Actividad`: revisar resumen, aislamiento por grupo y actualización.
- [ ] Abrir `Inactividad`: activar/desactivar, configurar período, listar y limpiar inactivos.
- [ ] Abrir `Verificadas`: listar y agregar un usuario verificado; modificar sus permisos.
- [ ] Abrir `Configuración`: consultar y cambiar cada opción disponible.
- [ ] Abrir `Mensajes automáticos`: crear, activar, cambiar frecuencia, enviar ahora y eliminar.
- [ ] Abrir `Limpieza`: limpiar mensajes recientes y confirmar límites.
- [ ] Abrir `Ayuda`: confirmar que solo muestra Emergencias, Recovery Key y Volver.
- [ ] Confirmar que cada cambio se refleja después de cerrar y volver a abrir el panel.
- [ ] Repetir acciones después de quitar al usuario sus permisos de Telegram y confirmar el rechazo.

## Cerbero y moderación

- [ ] Activar filtros y enviar un mensaje que deba ser detectado.
- [ ] Cambiar configuración anti-spam, enlaces, multimedia y menciones.
- [ ] Ejecutar warn, mute, unmute, ban, unban, kick y limpieza desde el panel.
- [ ] Confirmar que las órdenes delegadas aparecen en Supabase/Cerbero.
- [ ] Confirmar que Zeus no ejecuta funciones administrativas propias de Cerbero.
- [ ] Confirmar que un error de Cerbero se muestra al administrador y no queda silencioso.

## Criterio de aprobación

- [ ] Cada prueba tiene resultado `PASS` o incidencia reproducible.
- [ ] No se aplicó ninguna migración en producción.
- [ ] No se usó una Recovery Key real fuera del entorno autorizado.
- [ ] No se cambiaron permisos de grupos de producción durante la prueba.
