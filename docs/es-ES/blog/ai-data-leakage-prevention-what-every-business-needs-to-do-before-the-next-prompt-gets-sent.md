---
title: "Prevención de fugas de datos con IA: lo que toda empresa debe hacer
  antes de que se envíe el siguiente prompt"
date: 2026-04-03
description: La prevención de fugas de datos con IA protege la información
  empresarial confidencial de la exposición a través de herramientas de IA.
  Esto es lo que la causa, dónde ocurre y cómo detenerla.
author: triggerfish
tags:
  - AI agent
draft: false
---
La prevención de fugas de datos con IA hace referencia a las políticas, los controles técnicos y las prácticas organizativas que evitan que la información empresarial confidencial sea expuesta, retenida o utilizada de manera indebida cuando los empleados y los sistemas interactúan con herramientas de inteligencia artificial. Aborda una categoría de pérdida de datos que las herramientas de prevención tradicionales no fueron diseñadas para detectar.

El problema es engañosamente sencillo en su mecánica y engañosamente extendido en su ocurrencia. Un empleado pega un contrato de cliente en una herramienta de IA para obtener un resumen. Un desarrollador alimenta código fuente propietario en un asistente de codificación para corregir un error. Un miembro del equipo de finanzas envía un borrador de informe de resultados a una herramienta de redacción con IA para pulirlo. En cada caso, el empleado logró algo útil. En cada caso, datos organizativos confidenciales viajaron a una infraestructura que la organización no controla, bajo términos de servicio que el empleado nunca leyó, con prácticas de retención y uso que pueden incluir el entrenamiento del modelo con ese contenido. Ningún cortafuegos lo marcó. Ninguna alerta de DLP se activó. Ningún registro de auditoría lo capturó en una forma sobre la que los equipos de cumplimiento pudieran actuar. Ese es el problema de fuga de datos con IA, y se está manifestando en organizaciones de todos los tamaños y sectores a una escala que la mayoría de los programas de seguridad aún no han alcanzado. Esta guía explica qué impulsa las fugas de datos con IA, dónde crean la exposición más grave y qué deben implementar las organizaciones para prevenirlas.



![AI agent](/blog/images/submitting.jpg)

## **Por qué las herramientas de IA crean su propia categoría de fugas de datos**

### **El canal que esquiva los controles existentes**

Las herramientas tradicionales de prevención de pérdida de datos funcionan supervisando canales de datos conocidos y aplicando reglas para detectar contenido confidencial que se mueve a través de ellos. Se escanean los archivos adjuntos de correo electrónico. Se revisan las transferencias de archivos al almacenamiento en la nube. Se registran las escrituras en dispositivos USB. Estos controles reflejan un modelo de movimiento de datos que era preciso antes de que las herramientas de IA se convirtieran en parte estándar del entorno laboral.

Las herramientas de IA representan un canal de datos que la mayoría de las arquitecturas DLP existentes no clasifican ni supervisan correctamente. Desde la perspectiva del tráfico de red, un empleado que envía un documento confidencial a una herramienta de IA se ve idéntico a un empleado que usa cualquier otra aplicación web. La solicitud HTTPS a los servidores de la herramienta de IA es indistinguible en la capa de red de una solicitud a una aplicación de productividad, una base de datos de investigación o un sitio de noticias. La herramienta DLP ve tráfico web permitido. El equipo de seguridad no ve nada. Los datos confidenciales han salido del edificio.

Esta brecha arquitectónica es la razón por la que la prevención de fugas de datos con IA requiere una atención dedicada en lugar de asumir que los controles existentes la cubren. El modelo de amenazas es diferente, el canal de datos es diferente y los controles necesarios para abordarlo son diferentes de los que gestionan los escenarios convencionales de pérdida de datos.

### **Qué sucede con los datos después de entrar en una herramienta de IA**

Los riesgos específicos de fuga de datos dependen de lo que los proveedores de IA hagan con los datos enviados a sus sistemas, lo cual varía considerablemente entre proveedores, productos y niveles. Comprender el rango de prácticas ayuda a las organizaciones a calibrar sus esfuerzos de prevención en torno al riesgo real en lugar de una preocupación generalizada.

El uso de datos para el entrenamiento de modelos es el riesgo que más directamente transforma un evento de exposición de datos en un problema de fuga persistente. Cuando los términos de servicio de un proveedor permiten usar el contenido enviado para mejorar su modelo, los datos no solo pasan temporalmente por sus sistemas. Potencialmente influyen en los resultados futuros del modelo de maneras que podrían hacer aparecer fragmentos de esa información en respuestas a otros usuarios. Los acuerdos empresariales con los principales proveedores prohíben esto como término estándar, pero los niveles para consumidores y gratuitos comúnmente lo permiten, y los empleados que usan cuentas personales para tareas laborales normalmente operan bajo términos para consumidores.

La retención de registros de inferencia crea una ventana de exposición limitada en el tiempo en lugar de un riesgo de entrenamiento persistente. La mayoría de los proveedores de IA retienen registros de consultas y respuestas durante períodos definidos con fines de depuración, garantía de calidad y cumplimiento legal. Durante ese período de retención, los datos confidenciales enviados en esas consultas existen en la infraestructura del proveedor y son potencialmente accesibles para el personal del proveedor, están sujetos a los propios controles de seguridad del proveedor y potencialmente responden a procesos legales dirigidos al proveedor.

La transferencia transfronteriza de datos se produce cuando la infraestructura de inferencia de IA se encuentra en una jurisdicción distinta a la de la organización que envía los datos. Para las organizaciones con obligaciones de residencia de datos, esto crea una exposición de cumplimiento independiente de cualquier fallo de seguridad. Los datos pueden ser técnicamente seguros en la infraestructura del proveedor mientras vulneran simultáneamente los requisitos regulatorios sobre dónde pueden tratarse.

Comprender cómo los marcos de[ seguridad de IA](https://trigger.fish/security/) abordan cada una de estas categorías específicas de riesgo en el tratamiento de datos ayuda a las organizaciones a construir programas de prevención dirigidos a los riesgos reales que crea su panorama de herramientas de IA en lugar de preocupaciones genéricas sobre pérdida de datos.



![AI agent](/blog/images/concerned.jpg)

## **Dónde crea la fuga de datos con IA la exposición más grave**

### **Categorías de datos regulados y confidenciales con mayor riesgo**

No todos los datos organizativos conllevan el mismo riesgo de fuga. Las categorías de datos que crean la exposición más grave cuando entran en sistemas de IA no autorizados comparten una característica común: su tratamiento está regido por obligaciones legales, compromisos contractuales o sensibilidad competitiva que hacen que la divulgación no autorizada sea costosa de maneras que van más allá de la pérdida inmediata de información.

Los datos personales sujetos al RGPD, HIPAA o marcos equivalentes crean exposición regulatoria cuando se procesan a través de herramientas de IA sin la base jurídica, los acuerdos con proveedores y las salvaguardas técnicas que esos marcos exigen. Un solo empleado que envíe una hoja de cálculo con información personal de clientes a una herramienta de IA para consumidores con fines de limpieza de datos potencialmente ha creado una violación de datos notificable bajo el RGPD, una violación de Acuerdo de Asociado Comercial bajo HIPAA y un incidente de cumplimiento bajo cualquier número de regulaciones específicas del sector, todo en el tiempo que se tarda en pegar contenido en una ventana de chat.

El contenido legalmente privilegiado enviado a herramientas de IA crea preocupaciones sobre el privilegio abogado-cliente que los equipos legales en la mayoría de las organizaciones aún no han resuelto por completo. Si el tratamiento por parte de una herramienta de IA constituye una divulgación que renuncia al privilegio es una cuestión legal en evolución en la mayoría de las jurisdicciones, y la postura organizativa más segura es evitar que el contenido privilegiado llegue a herramientas de IA cuyo tratamiento no esté específicamente diseñado y contratado para los requisitos del sector legal.

La información técnica propietaria, incluido el código fuente, las especificaciones de productos, los algoritmos y los datos de investigación, representa inteligencia competitiva que las organizaciones invierten significativamente en proteger. Los asistentes de codificación con IA y las herramientas de análisis de documentos se encuentran entre las herramientas de IA más utilizadas en organizaciones de tecnología e investigación, y también son las herramientas que se utilizan con mayor frecuencia exactamente con las categorías de datos que las organizaciones más desearían mantener alejadas de sistemas externos.


<table>
  <thead>
    <tr>
      <th>Categoría de datos</th>
      <th>Riesgo principal por fuga de IA</th>
      <th>Consecuencia regulatoria o legal</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Datos personales del cliente</td>
      <td>Tratamiento no autorizado por terceros</td>
      <td>Notificación de violación del RGPD, violación de HIPAA, sanciones específicas del sector</td>
    </tr>
    <tr>
      <td>Datos personales del empleado</td>
      <td>Exposición de datos de RR. HH. a través de herramientas de IA de RR. HH.</td>
      <td>Vulneraciones de leyes laborales y de protección de datos</td>
    </tr>
    <tr>
      <td>Contenido legalmente privilegiado</td>
      <td>Posible renuncia al privilegio por divulgación</td>
      <td>Pérdida de protección legal para asuntos sensibles</td>
    </tr>
    <tr>
      <td>Código fuente propietario</td>
      <td>Exposición de inteligencia competitiva</td>
      <td>Pérdida de PI, incumplimiento contractual con clientes</td>
    </tr>
    <tr>
      <td>Información financiera en borrador</td>
      <td>Información material no pública previa a la divulgación</td>
      <td>Exposición a leyes de valores, riesgo de divulgación selectiva</td>
    </tr>
    <tr>
      <td>Información confidencial del cliente</td>
      <td>Incumplimiento de obligaciones profesionales de confidencialidad</td>
      <td>Daño a la relación con el cliente, responsabilidad profesional</td>
    </tr>
    <tr>
      <td>Secretos comerciales</td>
      <td>Inteligencia competitiva a través del entrenamiento de modelos</td>
      <td>Pérdida de protección de secretos comerciales si se divulgan públicamente</td>
    </tr>
  </tbody>
</table>



### **La dimensión de la IA en la sombra**

El reto más difícil de la prevención de fugas de datos con IA no son las herramientas que las organizaciones han aprobado y desplegado bajo marcos de gobierno. Son las herramientas que los empleados usan sin el conocimiento ni la supervisión de la organización. La IA en la sombra, el uso de herramientas de IA fuera de cualquier programa aprobado, genera la mayoría de los incidentes de fuga de datos con IA en la mayoría de las organizaciones porque opera completamente fuera de los controles que establece un programa de gobierno de IA.

El uso de IA en la sombra no es principalmente un fracaso de cumplimiento por parte de malos actores. Es una respuesta de productividad de empleados que han descubierto que las herramientas de IA ayudan a su trabajo y que han adoptado lo que es accesible en lugar de esperar procesos de aprobación organizativos que pueden no tener cronogramas claros. Comprender esa motivación es esencial para diseñar enfoques de prevención que realmente reduzcan las fugas en lugar de llevar el uso aún más a la clandestinidad.

La prevención más eficaz de IA en la sombra combina visibilidad sobre qué herramientas de IA se usan en toda la organización, un programa de herramientas aprobadas claro y accesible que satisface las necesidades reales de los empleados, y un canal de divulgación no punitivo para los empleados que ya han usado herramientas fuera del programa aprobado. Las organizaciones que responden a la IA en la sombra principalmente con prohibición descubren que la necesidad subyacente de productividad sigue siendo satisfecha por medios progresivamente menos visibles, creando una mayor exposición a fugas en lugar de menor.

Revisar cómo las decisiones de[ arquitectura de IA](https://trigger.fish/architecture/) sobre el despliegue de herramientas de IA aprobadas afectan al atractivo de las alternativas en la sombra ayuda a las organizaciones a diseñar su programa aprobado para que sea el camino de menor resistencia en lugar del camino de mayor fricción de cumplimiento.

## **Los controles técnicos y organizativos que realmente funcionan**

### **Controles técnicos para la prevención de fugas de datos con IA**

Los controles técnicos para la prevención de fugas de datos con IA operan en varias capas, cada una abordando diferentes aspectos de cómo los datos confidenciales llegan a los sistemas de IA. Los programas eficaces combinan estos controles en capas en lugar de depender de un único enfoque.

Los controles a nivel de red pueden restringir el acceso a servicios de IA no aprobados desde las redes y dispositivos organizativos bloqueando o supervisando el tráfico a dominios de herramientas de IA que no están en la lista aprobada. Este enfoque es más eficaz en redes corporativas gestionadas que en entornos de trabajo remoto donde los empleados pueden usar redes y dispositivos personales, y requiere mantenimiento continuo a medida que surgen nuevas herramientas de IA y las herramientas existentes cambian su infraestructura de dominio.

La prevención de pérdida de datos de endpoints configurada para reconocer patrones de carga de herramientas de IA y aplicar inspección de contenido a los datos enviados a través de interfaces de IA amplía la cobertura DLP al canal de IA que las arquitecturas DLP heredadas pasan por alto. Esto requiere herramientas DLP configuradas específicamente para patrones de tráfico de herramientas de IA en lugar de únicamente canales convencionales de exfiltración.

Las extensiones de navegador y los controles basados en agentes que aplican políticas de clasificación de datos en el punto de envío, impidiendo que el contenido clasificado por encima de un umbral de sensibilidad definido se envíe a herramientas de IA fuera del programa aprobado, representan un enfoque más específico que el bloqueo a nivel de red. Estos controles pueden configurarse para advertir a los usuarios que se acercan a un límite de política en lugar de únicamente bloquear después de que se cruza, creando un mecanismo de refuerzo conductual junto con el control técnico.

Los productos de pasarela de IA empresarial han surgido como una categoría de control dedicada que enruta todo el tráfico de IA organizativo a través de una capa centralizada de inspección y aplicación de políticas. Estos productos proporcionan visibilidad del uso de herramientas de IA en toda la organización, aplican clasificación de datos e inspección de contenido a todos los envíos de IA, hacen cumplir las políticas de herramientas aprobadas y generan registros de auditoría en formatos con los que los equipos de cumplimiento y seguridad pueden trabajar.


<table>
  <thead>
    <tr>
      <th>Tipo de control</th>
      <th>Lo que aborda</th>
      <th>Limitación</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Bloqueo de red</td>
      <td>Evita el acceso a herramientas de IA no aprobadas en la red corporativa</td>
      <td>Ineficaz en redes personales y dispositivos no gestionados</td>
    </tr>
    <tr>
      <td>DLP de endpoint para IA</td>
      <td>Inspecciona el contenido enviado a través de interfaces de IA</td>
      <td>Requiere configuración específica de IA más allá del DLP estándar</td>
    </tr>
    <tr>
      <td>Controles de extensión de navegador</td>
      <td>Aplicación de políticas en el punto de envío a la IA</td>
      <td>Cobertura limitada a entornos de navegador gestionados</td>
    </tr>
    <tr>
      <td>Pasarela de IA empresarial</td>
      <td>Visibilidad, inspección y aplicación de políticas centralizadas</td>
      <td>Requiere enrutar todo el tráfico de IA a través de la infraestructura de la pasarela</td>
    </tr>
    <tr>
      <td>Etiquetas de clasificación de datos</td>
      <td>Guía las decisiones de los empleados sobre la idoneidad de las herramientas de IA</td>
      <td>Depende del cumplimiento del empleado en lugar de la aplicación técnica</td>
    </tr>
    <tr>
      <td>Controles de acceso de confianza cero</td>
      <td>Limita el acceso a herramientas de IA a usuarios autorizados en contextos definidos</td>
      <td>No aborda el contenido de los envíos autorizados</td>
    </tr>
  </tbody>
</table>



### **Controles organizativos que complementan la prevención técnica**

Los controles técnicos reducen las fugas mediante la aplicación automatizada. Los controles organizativos reducen las fugas a través del juicio y el comportamiento del empleado que determinan si los controles técnicos se eluden, se evitan o se integran genuinamente en cómo se realiza el trabajo.

Una política clara de clasificación de datos que asigna niveles de sensibilidad a entornos de procesamiento de IA permitidos ofrece a los empleados una regla de decisión que pueden aplicar de manera consistente sin consultar documentos de política para cada tarea. Cuando un empleado sabe que los datos clasificados como confidenciales solo pueden tratarse a través de herramientas de IA locales o herramientas en la nube de nivel empresarial con acuerdos de datos firmados, dispone de una guía práctica en lugar de una instrucción vaga de tener cuidado.

La formación que utiliza escenarios concretos y específicos del rol en lugar de contenido genérico de concienciación sobre protección de datos produce un cambio de comportamiento que la formación abstracta no logra. Un ingeniero que puede describir qué sucede con el código fuente enviado a un asistente de codificación popular bajo sus términos de servicio predeterminados tiene un conocimiento práctico que cambia su comportamiento. Un ingeniero que ha asistido a una formación sobre principios de protección de datos tiene conciencia que puede o no traducirse en un comportamiento diferente cuando una fecha límite crea presión para usar la herramienta más rápida disponible.

Los procesos de divulgación de incidentes que tratan las divulgaciones por primera vez del uso pasado de IA en la sombra como oportunidades de aprendizaje en lugar de vulneraciones de cumplimiento crean la seguridad psicológica que anima a los empleados a sacar a la luz la exposición existente en lugar de ocultarla. El coste organizativo de las fugas desconocidas es mayor que el coste de las fugas conocidas que pueden evaluarse y abordarse.

Comprender cómo las[ funciones de IA](https://trigger.fish/features/) en las herramientas de IA empresariales aprobadas comunican sus prácticas de tratamiento de datos a los usuarios ayuda a las organizaciones a construir formación que conecte los requisitos de política con los comportamientos específicos de las herramientas que los empleados encuentran en la práctica, en lugar de tratar la conexión entre la política y la herramienta como algo que los empleados deben descifrar por su cuenta.



![AI agent](/blog/images/session.jpg)

## **Cómo construir un programa de prevención de fugas de datos con IA**

### **El fundamento del inventario y la evaluación**

Los programas de prevención de fugas de datos con IA que funcionan comienzan con una imagen precisa de qué herramientas de IA se usan en toda la organización, no solo qué herramientas se han aprobado oficialmente. La brecha entre esos dos inventarios define el alcance inmediato del programa de prevención.

Construir el inventario real de herramientas de IA requiere combinar múltiples fuentes de datos porque ninguna fuente única captura la imagen completa. Los inventarios de software gestionados por TI capturan las herramientas adquiridas oficialmente. El análisis del tráfico de red revela los dominios a los que llega el tráfico de herramientas de IA en toda la organización. Las encuestas a empleados y las entrevistas departamentales revelan las herramientas que los empleados están usando y que la adquisición de TI nunca ve. Las extensiones de navegador y los inventarios de endpoints identifican las herramientas de IA instaladas a nivel de dispositivo individual. El inventario completo es la unión de todas estas fuentes, y casi siempre es mayor y más variado de lo que cualquier organización espera antes de hacer el ejercicio.

Una vez que existe el inventario, cada herramienta necesita una evaluación frente a los requisitos de seguridad de datos que cubra las prácticas de tratamiento de datos del proveedor, el estado de certificación, la disponibilidad de protección contractual y las categorías de datos con las que los empleados realmente la están usando. El resultado de la evaluación es una clasificación de cada herramienta de IA del inventario por niveles de riesgo, desde aprobada para todas las categorías de datos, pasando por aprobada con restricciones, hasta prohibida pendiente de revisión y prohibida de forma definitiva.

### **Protecciones de proveedores y contractuales**

Los programas de prevención que se basan únicamente en controles conductuales y técnicos sin protecciones contractuales correspondientes crean una estructura de gobierno que es incompleta en su base. Los controles técnicos reducen la probabilidad de fugas a través de herramientas no autorizadas. Las protecciones contractuales definen qué protecciones se aplican cuando se usan herramientas autorizadas y qué recurso tiene la organización cuando esas protecciones no se respetan.

Cada proveedor de IA cuyas herramientas tratan datos organizativos por encima del nivel de sensibilidad más bajo necesita un acuerdo de tratamiento de datos firmado que prohíba explícitamente el uso de datos de entrenamiento, defina los límites de retención, se comprometa a notificar las violaciones dentro de los plazos requeridos y documente los controles de seguridad aplicados a los datos organizativos. Para las organizaciones sanitarias, un Acuerdo de Asociado Comercial que cubra el producto específico de IA es un requisito legal en lugar de una preferencia contractual.

El programa de protección contractual necesita mantenimiento al igual que los controles técnicos. Los proveedores actualizan sus términos de servicio. Los productos que estaban cubiertos por un acuerdo pueden separarse de él por un cambio en la cartera de productos. Los períodos de certificación expiran. Incorporar un ciclo anual de revisión de acuerdos con proveedores al programa evita la situación en la que los datos organizativos se tratan bajo acuerdos que ya no reflejan las prácticas reales del proveedor.

Una[ guía de IA](https://trigger.fish/guide/) integral sobre cómo estructurar programas de prevención de fugas de datos con IA, desde el inventario y la evaluación hasta los controles técnicos y la gestión de proveedores, ayuda a las organizaciones a construir programas que aborden el reto completo de prevención en lugar de la porción más visible.

## **Cosas que debéis saber**

Varias realidades importantes sobre la prevención de fugas de datos con IA que las organizaciones encuentran constantemente al construir sus programas:

Los productos de nivel para consumidores de los proveedores de IA empresarial tienen prácticas de tratamiento de datos diferentes a sus productos empresariales, a veces drásticamente. La misma capacidad subyacente de IA accedida a través de una cuenta personal y a través de una cuenta empresarial puede tener políticas de datos de entrenamiento, prácticas de retención y disponibilidad de protección contractual completamente diferentes. Los empleados que acceden a herramientas de IA empresariales a través de cuentas personales porque las cuentas organizativas requieren aprobación o cuestan dinero están usando protecciones de nivel para consumidores en datos laborales sin reconocer la diferencia.

La regla del 30 % para la IA se aplica de manera útil al diseño de programas de prevención de fugas de datos. Los controles técnicos automatizados deben gestionar aproximadamente el 30 % del trabajo de prevención, específicamente las tareas de alta frecuencia y aplicación de políticas que la automatización gestiona de manera consistente a escala. El juicio humano y el gobierno organizativo cubren el 70 % restante que implica evaluación de riesgos, evaluación de proveedores, respuesta a incidentes, y la formación y construcción de cultura que determina si los controles técnicos se integran en cómo se realiza realmente el trabajo o se tratan como obstáculos que hay que sortear.

El uso de herramientas de IA basadas en navegador es la categoría más difícil de controlar únicamente mediante el bloqueo a nivel de red. Los empleados que trabajan de forma remota en redes personales, usando dispositivos personales para tareas laborales, o accediendo a herramientas de IA a través de interfaces de navegador que se asemejan al uso web general presentan un reto de control que los enfoques basados en endpoints abordan mejor que los basados en red.

Las herramientas de IA generativa integradas en software de productividad ampliamente utilizado crean exposición a fugas que no parece uso de herramientas de IA para la mayoría de los empleados. Cuando un procesador de textos usa IA para sugerir completados de texto, una hoja de cálculo usa IA para interpretar la entrada de datos, o un cliente de correo electrónico usa IA para redactar respuestas, el empleado está usando IA sin ninguna de las decisiones deliberadas que podrían incitarle a considerar la clasificación de datos. Los programas de gobierno que abordan únicamente herramientas de IA independientes tienen puntos ciegos aquí.

La advertencia de Stephen Hawking sobre la IA se centró en el riesgo existencial de los sistemas superinteligentes en lugar de la fuga de datos específicamente, pero su precaución más amplia sobre avanzar más rápido con la capacidad de IA que con el gobierno de IA se traduce directamente al problema de la fuga de datos. Las organizaciones que despliegan herramientas de IA más rápido de lo que sus marcos de protección de datos pueden adaptarse crean exactamente la exposición no gestionada hacia la que apuntaba la preocupación general de Hawking sobre el gobierno insuficiente de la IA. La lección práctica para la prevención de fugas de datos es que la infraestructura de gobierno debe desarrollarse por delante de la escala de despliegue en lugar de ponerse al día con ella.

La calidad del rastro de auditoría determina hasta qué punto las organizaciones pueden responder a los incidentes de fuga cuando ocurren. Saber que un empleado envió datos confidenciales a una herramienta de IA no autorizada es útil. Saber qué datos específicos se enviaron, cuándo, cuál fue la respuesta de la herramienta de IA y qué hizo el empleado con esa respuesta es lo que hace posible una respuesta eficaz a incidentes. La infraestructura de registro para la prevención de fugas de datos con IA debe construirse para la utilidad de investigación de incidentes, no solo para la satisfacción de casillas de verificación de cumplimiento.

Los empleados y oficinas internacionales añaden complejidad de residencia de datos a la prevención de fugas. Una herramienta de IA aprobada para su uso con datos comerciales no personales en una jurisdicción puede desencadenar violaciones de residencia de datos cuando se usa con las mismas categorías de datos en otra. Las organizaciones multinacionales necesitan programas de prevención de fugas de datos que tengan en cuenta la variación jurisdiccional en lugar de aplicar políticas globales uniformes sin sensibilidad geográfica.

## **Prevenir las fugas de datos con IA como una disciplina continua**

La prevención de fugas de datos con IA no es un proyecto con una fecha de finalización. Es una disciplina operativa continua que debe evolucionar al ritmo del panorama de herramientas de IA, el entorno regulatorio y la huella de IA organizativa que gobierna. Las herramientas que no existían hace doce meses son partes estándar del flujo de trabajo de muchos empleados hoy. Las regulaciones que eran aspiracionales hace un año son requisitos exigibles ahora. Las capacidades de IA que se limitaban a herramientas independientes están integradas en la infraestructura operativa de maneras que difuminan el límite entre el uso de herramientas de IA y el uso regular del sistema.

Las organizaciones que construyen la prevención de fugas de datos con IA como un programa operativo sostenible, con la infraestructura de visibilidad, los procesos de gobierno y los fundamentos culturales que la hacen autorreforzante en lugar de dependiente de la aplicación, están construyendo una protección que se acumula con el tiempo. Cada herramienta aprobada añadida al programa reduce el atractivo de las alternativas en la sombra. Cada ciclo de formación mejora el juicio del empleado sobre la clasificación de datos y la selección de herramientas. Cada revisión de acuerdo con proveedores detecta la desviación entre las protecciones documentadas y reales antes de que cree una exposición no detectada.

Los datos que fluyen a través de las herramientas de IA de vuestra organización son parte de la información más confidencial que genera vuestra empresa, tratados en contextos donde los controles normales que rigen el tratamiento de datos están menos maduros. Construir el programa de prevención que los proteja apropiadamente no es un ejercicio de cumplimiento. Es una inversión fundamental de seguridad en el negocio habilitado por IA en el que vuestra organización ya se está convirtiendo.

## **Preguntas frecuentes**

### **¿Qué es la fuga de datos en la IA?**

**La fuga de datos en la IA hace referencia a la exposición de información organizativa confidencial a través del uso de herramientas de IA, que ocurre cuando los empleados envían datos confidenciales a sistemas de IA cuyas prácticas de tratamiento de datos del proveedor, políticas de retención o uso de datos de entrenamiento crean divulgación no autorizada más allá del propósito de tratamiento previsto.** Se diferencia de la fuga de datos convencional porque ocurre a través de un canal que las herramientas DLP existentes a menudo no supervisan, a través de acciones de empleados que son genuinamente productivas en lugar de negligentes o maliciosas, y con consecuencias que pueden incluir no solo exposición inmediata sino codificación persistente de información confidencial en la infraestructura del modelo del proveedor.

### **¿Cuál es la regla del 30 % para la IA?**

**La regla del 30 % para la IA es el principio de que los sistemas de IA y los controles automatizados deben gestionar aproximadamente el 30 % de una función de flujo de trabajo o programa, específicamente las tareas de alta frecuencia, bien definidas y ejecutables de manera consistente donde la automatización proporciona beneficios claros de eficiencia y fiabilidad, mientras que el juicio humano y el gobierno cubren el 70 % restante que implica evaluación contextual, decisiones de riesgo y la responsabilidad que debe recaer en las personas en lugar de en sistemas automatizados.** En la prevención de fugas de datos con IA específicamente, esto significa que los controles técnicos automatizados gestionan la aplicación rutinaria de políticas mientras que el gobierno humano posee la evaluación de riesgos, la evaluación de proveedores, la respuesta a incidentes y las dimensiones culturales y de formación que determinan si los controles técnicos se integran en el comportamiento real.

### **¿Cuál fue la advertencia de Stephen Hawking sobre la IA?**

**La advertencia principal de Stephen Hawking sobre la IA se refería al posible riesgo existencial de la inteligencia artificial general que supera las capacidades cognitivas humanas y persigue objetivos desalineados con el bienestar humano, expresando su preocupación de que la humanidad estaba avanzando demasiado rápido en el desarrollo de capacidades de IA sin la atención adecuada a la seguridad y el gobierno.** Si bien su preocupación se dirigía al riesgo existencial a largo plazo en lugar de a la seguridad de datos empresariales a corto plazo, el principio subyacente de gobierno se traduce directamente al despliegue práctico de IA: las organizaciones que avanzan en la capacidad de IA más rápido de lo que sus marcos de gobierno pueden adaptarse crean el riesgo no gestionado que resulta de la capacidad sin responsabilidad.

### **¿Cómo usar la IA sin filtrar datos?**

**Usar la IA sin filtrar datos requiere cuatro prácticas aplicadas de manera consistente: enviar únicamente datos que hayan sido evaluados frente a las categorías de datos aprobadas de la herramienta de IA antes de cada uso, depender exclusivamente de herramientas de IA de nivel empresarial con acuerdos firmados de tratamiento de datos que prohíban el uso de datos de entrenamiento, comprender las prácticas específicas de tratamiento de datos de cada herramienta de IA utilizada para tareas laborales, incluidas las integradas en el software de productividad, y seguir las políticas organizativas de clasificación de datos que definen qué niveles de sensibilidad están permitidos con qué herramientas de IA.** Para las categorías de datos de mayor sensibilidad, el único enfoque completamente a prueba de fugas es usar herramientas de IA desplegadas en infraestructura privada donde los datos nunca salen del perímetro de red propio de la organización.

### **¿Qué no deberíais decirle a ChatGPT?**

**A través de la interfaz estándar para consumidores de ChatGPT, los empleados no deben enviar información personal de clientes, registros de empleados, comunicaciones legalmente privilegiadas, código fuente o algoritmos propietarios, borradores de divulgaciones financieras o información material no pública, secretos comerciales, información confidencial de clientes, ni ningún otro dato cuya divulgación no autorizada crearía consecuencias legales, regulatorias, competitivas o contractuales para la organización.** La versión para consumidores de ChatGPT opera bajo términos de servicio que no incluyen los acuerdos de tratamiento de datos, las prohibiciones de datos de entrenamiento y las protecciones contractuales que hacen que las herramientas de IA de nivel empresarial sean apropiadas para datos comerciales, lo que significa que el contenido enviado a través de cuentas personales puede ser retenido y potencialmente utilizado de maneras que las organizaciones no pueden controlar ni siquiera descubrir.
