---
title: "GDPR y herramientas de AI: lo que toda empresa debe saber antes de
  implementar AI en Europa"
date: 2026-03-03
description: El GDPR y las herramientas de AI se cruzan en torno al procesamiento
  de datos, el consentimiento y las decisiones automatizadas. Esto es lo que las
  empresas deben entender para cumplir la normativa al implementar AI en Europa.
author: triggerfish
tags:
  - AI agent
draft: false
---



El GDPR y las herramientas de AI se cruzan en un punto crítico para cualquier organización que procese datos personales de residentes europeos mediante sistemas de inteligencia artificial. La regulación se aplica plenamente a las implementaciones de AI, lo que significa que toda herramienta que recopile, procese o actúe sobre datos personales debe cumplir con los requisitos del GDPR en cuanto a base legal, transparencia y minimización de datos, o se arriesga a sanciones significativas.

Muchas organizaciones han avanzado rápidamente en la adopción de AI sin detenerse a preguntarse si sus nuevas herramientas son realmente legales bajo la ley europea de protección de datos. La respuesta no siempre es cómoda. La AI introduce actividades de procesamiento de datos que el GDPR no fue originalmente redactado para abordar, pero que sí cubre completamente bajo su marco existente. El perfilado automatizado, el procesamiento a gran escala de datos personales, las transferencias transfronterizas de datos provocadas por la infraestructura de AI en la nube y los sistemas opacos de toma de decisiones se encuentran todos dentro del alcance regulatorio del GDPR. Entender exactamente dónde recaen las obligaciones y cómo construir implementaciones de AI que las satisfagan ya no es opcional para las empresas que operan o venden a los mercados europeos. Esta guía recorre lo que realmente requiere el cumplimiento normativo y dónde la mayoría de los equipos suelen equivocarse.



![Ai agent](/blog/images/flag.jpg)

## **Por qué el GDPR se aplica a las herramientas de AI de forma más amplia de lo que la mayoría de los equipos cree**

### **Cada interacción de AI que involucra datos personales es un evento de procesamiento**

El GDPR define el procesamiento de datos de manera amplia. Cualquier operación realizada sobre datos personales, incluida la recopilación, el almacenamiento, la recuperación, el uso, la divulgación y el borrado, queda dentro del alcance de la regulación. Cuando una herramienta de AI recibe un nombre, una dirección de correo electrónico, un patrón de comportamiento, una grabación de voz o cualquier otra información que se relacione con una persona identificable, está procesando datos personales bajo la definición del GDPR desde el momento en que esos datos ingresan al sistema.

Esto sorprende a muchas organizaciones porque el modelo mental intuitivo del cumplimiento del GDPR se centra en las bases de datos y el almacenamiento. Si almacenan registros de clientes, cumplen con las reglas de almacenamiento. Pero el procesamiento de AI es procesamiento independientemente de si algo se almacena permanentemente. Una herramienta de AI que analiza una transcripción de servicio al cliente para clasificar el sentimiento y descarta inmediatamente la transcripción aún ha procesado datos personales. La base legal para hacerlo, y las obligaciones de transparencia que la acompañan, se aplican a esa interacción.

La implicación práctica es que su evaluación de cumplimiento del GDPR no puede detenerse en sus bases de datos y sistemas CRM. Cada herramienta de AI que utiliza su organización debe evaluarse en cuanto a qué datos personales toca, sobre qué base legal y bajo qué condiciones.

### **El problema de la base legal con las herramientas de AI**

El GDPR exige que toda actividad de procesamiento que involucre datos personales tenga una base legal válida. Las seis bases disponibles son consentimiento, ejecución de contrato, obligación legal, intereses vitales, tarea pública e intereses legítimos. Para la mayoría de las implementaciones comerciales de AI, las opciones relevantes son el consentimiento, la ejecución del contrato y los intereses legítimos.

El desafío con las herramientas de AI es que las actividades de procesamiento que realizan son a menudo difíciles de describir con suficiente especificidad para cumplir con los requisitos de transparencia del GDPR para el consentimiento o el equilibrio de intereses legítimos. Decirles a los usuarios que sus datos serán procesados por sistemas de AI para mejorar el servicio no es lo suficientemente específico. Explicar exactamente qué datos fluyen a través de qué sistema de AI con qué propósito, retenidos durante cuánto tiempo, compartidos con qué procesadores y utilizados para informar qué decisiones es lo que la regulación realmente requiere.

Las organizaciones que no han mapeado sus flujos de datos de AI en detalle no pueden cumplir con este requisito porque genuinamente no saben qué están divulgando. El trabajo de cumplimiento y el trabajo de transparencia son el mismo trabajo.


<table>
  <thead>
    <tr>
      <th>Base legal</th>
      <th>Cuándo se aplica a la AI</th>
      <th>Requisito clave</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Consentimiento</td>
      <td>Procesamiento de AI no necesario para el servicio, claramente opcional</td>
      <td>Otorgado libremente, específico, informado, inequívoco</td>
    </tr>
    <tr>
      <td>Ejecución de contrato</td>
      <td>AI directamente necesaria para entregar un servicio contratado</td>
      <td>Procesamiento limitado a lo que el contrato requiere</td>
    </tr>
    <tr>
      <td>Intereses legítimos</td>
      <td>Existe un beneficio empresarial y no anula los derechos individuales</td>
      <td>Evaluación de intereses legítimos documentada</td>
    </tr>
    <tr>
      <td>Obligación legal</td>
      <td>AI utilizada para cumplir con un requisito legal</td>
      <td>Debe existir y documentarse una obligación legal específica</td>
    </tr>
    <tr>
      <td>Tarea pública</td>
      <td>Autoridades públicas y organizaciones con mandatos públicos</td>
      <td>Debe basarse en la ley de la Unión o de los Estados miembros</td>
    </tr>
  </tbody>
</table>



Alinear la documentación de[ AI security](https://trigger.fish/security/) y la base legal desde el inicio de una implementación evita la situación en la que tienen un sistema de AI técnicamente seguro funcionando sobre una base legalmente inestable.



![AI agent](/blog/images/legal-compliance.jpg)

## **Lo que los cambios del GDPR significan específicamente para la AI**

### **La interpretación regulatoria en evolución**

El GDPR se finalizó en 2016 y entró en vigor en 2018, anticipándose por varios años a la generación actual de modelos de lenguaje a gran escala. El texto de la regulación no menciona la AI generativa, los modelos fundacionales ni las canalizaciones de inferencia. Lo que sí contiene es un marco basado en principios lo suficientemente amplio como para capturar estas tecnologías, y las autoridades de protección de datos de los Estados miembros de la UE han ido emitiendo de manera constante guías que aclaran cómo se aplican esos principios.

La acción de cumplimiento de la autoridad italiana de protección de datos contra ChatGPT en 2023 fue la señal más clara de que los reguladores estaban preparados para actuar sobre preocupaciones del GDPR específicas de la AI. La acción se centró en la falta de una base legal clara de OpenAI para procesar los datos de los usuarios italianos, la ausencia de mecanismos de verificación de edad y la transparencia insuficiente sobre cómo se usaban los datos personales en el entrenamiento del modelo. La herramienta fue suspendida temporalmente en Italia y restablecida solo después de que OpenAI realizara cambios específicos de cumplimiento.

Otras autoridades nacionales de protección de datos en toda la UE han emitido desde entonces guías que abordan los datos de entrenamiento de AI, la toma de decisiones automatizada y las condiciones bajo las cuales las salidas generadas por AI constituyen procesamiento de datos personales sobre las personas cuyos datos se usaron para entrenar el modelo.

La dirección del rumbo es clara. El cumplimiento del GDPR está avanzando más profundamente en el territorio específico de la AI, y las organizaciones que han tratado el cumplimiento de la AI como un problema futuro están descubriendo que se ha convertido en un problema presente.

### **Cómo la Ley de AI de la UE se superpone al GDPR**

La Ley de AI de la UE, que entró en vigor en 2024, agrega una capa regulatoria paralela que funciona junto al GDPR en lugar de reemplazarlo. Mientras que el GDPR rige lo que sucede con los datos personales, la Ley de AI rige las características y el comportamiento de los propios sistemas de AI, particularmente aquellos clasificados como de alto riesgo.

Para las empresas que implementan herramientas de AI que interactúan con datos personales, ambos marcos se aplican simultáneamente. Un sistema de AI utilizado en la selección de empleo, la evaluación crediticia o el triaje sanitario está sujeto a los requisitos de la Ley de AI sobre transparencia, supervisión humana y precisión, al tiempo que está sujeto a los requisitos del GDPR para cada dato personal que procesa.

Entender cómo las decisiones de[ AI architecture](https://trigger.fish/architecture/) afectan el cumplimiento bajo ambos marcos ayuda a las organizaciones a diseñar sistemas que satisfagan el panorama regulatorio completo en lugar de optimizar para una regulación a expensas de la otra.

## **El Artículo 22 y la toma de decisiones automatizada**

### **Lo que el Artículo 22 realmente prohíbe**

El Artículo 22 del GDPR otorga a las personas el derecho a no ser objeto de decisiones basadas únicamente en el procesamiento automatizado, incluido el perfilado, que produzcan efectos legales o similarmente significativos sobre ellas. Esta es una de las disposiciones más directamente relevantes para la AI en la regulación y una de las más comúnmente malinterpretadas.

La prohibición no es sobre el uso de AI en los procesos de toma de decisiones. Es específicamente sobre decisiones tomadas únicamente por sistemas automatizados donde ningún humano revisa significativamente el resultado antes de que afecte a la persona. Una AI de puntuación crediticia que genera una recomendación que un oficial de préstamos humano considera y confirma o anula no activa el Artículo 22. Un sistema que aprueba o rechaza automáticamente solicitudes de préstamo basándose en la salida algorítmica sin un humano en el bucle de decisión sí lo hace.

Para las herramientas de AI utilizadas en RRHH, segmentación de clientes, detección de fraude y contextos similares, el análisis del Artículo 22 es esencial. Si su herramienta de AI toma decisiones que afectan el acceso de las personas a servicios, oportunidades laborales o productos financieros, y ningún humano está revisando genuinamente esas decisiones antes de que se materialicen, ustedes tienen un problema de cumplimiento del Artículo 22.

Las tres excepciones al Artículo 22 son la necesidad contractual, el consentimiento explícito y la autorización legal. Cada una requiere condiciones adicionales específicas, incluido el derecho a la revisión humana, el derecho a impugnar la decisión y el derecho a obtener una explicación de la lógica involucrada.


<table>
  <thead>
    <tr>
      <th>Tipo de decisión automatizada</th>
      <th>¿Se activa el Artículo 22?</th>
      <th>Ruta de cumplimiento</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Recomendación de AI revisada por un humano antes de actuar</td>
      <td>No</td>
      <td>Se aplican obligaciones estándar de procesamiento del GDPR</td>
    </tr>
    <tr>
      <td>Aprobación o rechazo totalmente automatizado con efecto legal</td>
      <td>Sí</td>
      <td>Debe basarse en una excepción con derecho a revisión humana</td>
    </tr>
    <tr>
      <td>Perfilado automatizado utilizado para segmentar listas de marketing</td>
      <td>Depende de la significancia</td>
      <td>Evaluar si los efectos son legalmente significativos</td>
    </tr>
    <tr>
      <td>Puntuación de contenido generada por AI que influye en una decisión de empleo</td>
      <td>Sí</td>
      <td>Excepción de contrato o consentimiento más revisión humana</td>
    </tr>
    <tr>
      <td>Alerta de fraude que requiere investigación humana antes de la acción sobre la cuenta</td>
      <td>No</td>
      <td>La revisión humana rompe la cadena únicamente automatizada</td>
    </tr>
  </tbody>
</table>



Revisar las[ AI features](https://trigger.fish/features/) en las herramientas que están considerando implementar ayuda a identificar cuáles incorporan puntos de control humanos significativos y cuáles enrutan decisiones automáticamente sin revisión humana.



![AI agent](/blog/images/a-person.jpg)

## **El Artículo 37 y el requisito del Responsable de Protección de Datos**

### **Cuándo las implementaciones de AI requieren un DPO**

El Artículo 37 del GDPR exige que ciertas organizaciones designen un Responsable de Protección de Datos. El requisito se aplica a las autoridades y organismos públicos, las organizaciones cuyas actividades principales requieran monitoreo sistemático a gran escala de las personas y las organizaciones cuyas actividades principales involucren el procesamiento a gran escala de datos de categorías especiales o datos relacionados con condenas penales.

Las herramientas de AI activan frecuentemente esta evaluación. Una empresa minorista que implementa AI para análisis del comportamiento en millones de interacciones con clientes está realizando monitoreo sistemático a gran escala. Una organización sanitaria que utiliza AI para procesar registros de pacientes a escala está procesando datos de categoría especial a gran escala. Ambos escenarios apuntan a un requisito obligatorio de DPO.

Incluso cuando el requisito del DPO no es estrictamente obligatorio, la función que cumple, supervisión de las actividades de procesamiento de datos, enlace con autoridades de supervisión y asesoramiento independiente sobre cumplimiento, es prácticamente esencial para las organizaciones que ejecutan sistemas de AI que tocan volúmenes significativos de datos personales. Muchas empresas que no están técnicamente obligadas a designar un DPO lo hacen porque el valor operativo lo justifica.

El DPO debe involucrarse en las implementaciones de AI antes de que entren en funcionamiento, no consultarse posteriormente cuando surjan problemas. Incluir al DPO en el proceso de evaluación de herramientas, la Evaluación de Impacto sobre la Protección de Datos y la revisión del acuerdo con el proveedor crea el rastro de supervisión documentado que los reguladores esperan ver.

### **Evaluaciones de Impacto sobre la Protección de Datos para AI**

El Artículo 35 del GDPR requiere una Evaluación de Impacto sobre la Protección de Datos antes de implementar cualquier procesamiento que pueda resultar en un alto riesgo para las personas. Los sistemas de AI que involucran perfilado a gran escala, monitoreo sistemático o toma de decisiones automatizada con efectos significativos casi siempre activan este requisito.

Una DPIA adecuada para una herramienta de AI cubre qué datos personales procesa el sistema y por qué, la necesidad y proporcionalidad del procesamiento, los riesgos para las personas y cómo se mitigarán, y las medidas implementadas para demostrar el cumplimiento. No es un documento único. Cuando la herramienta de AI cambia, cuando las entradas de datos cambian, o cuando el contexto empresarial cambia materialmente, la DPIA debe revisarse.

Una[ AI guide](https://trigger.fish/guide/) práctica sobre la metodología de DPIA para sistemas de AI ayuda a los equipos de cumplimiento a estructurar evaluaciones que satisfagan las expectativas de la autoridad de supervisión en lugar de producir documentación que parezca exhaustiva pero pase por alto el análisis sustantivo del riesgo que los reguladores buscan.

## **Cosas que hay que saber**

Varios puntos importantes sobre el GDPR y las herramientas de AI que tienden a surgir solo después de que ya han ocurrido problemas:

Entrenar modelos de AI con datos personales requiere su propia evaluación de base legal. Si están ajustando un modelo con datos de clientes, datos de empleados o cualquier otro dato personal que su organización posea, esa actividad de entrenamiento es un propósito de procesamiento distinto que necesita su propia base legal, separada del propósito original de recopilación.

Los derechos de los interesados se aplican a los datos procesados por AI. Las personas conservan el derecho a acceder, rectificar, borrar y portar sus datos personales incluso cuando han sido procesados por un sistema de AI. Si su herramienta de AI no puede respaldar estos derechos operativamente, eso es una brecha de cumplimiento independientemente de lo buenos que sean los demás controles de seguridad de la herramienta.

Los procesadores y subprocesadores deben estar documentados. Cada proveedor de AI que procese datos personales en su nombre debe estar listado en sus Registros de Actividades de Procesamiento. Sus subprocesadores, los proveedores de infraestructura, las empresas de alojamiento y otros proveedores en los que confían, deben divulgarse en sus Acuerdos de Procesamiento de Datos con ellos.

La seudonimización reduce el riesgo, pero no elimina las obligaciones del GDPR. Los datos que han sido seudonimizados, es decir, los identificadores han sido reemplazados con códigos, siguen siendo datos personales bajo el GDPR si la reidentificación es razonablemente posible. Las herramientas de AI que procesan datos seudonimizados aún están procesando datos personales.

Las transferencias transfronterizas provocadas por la infraestructura de AI requieren mecanismos de transferencia. Si su proveedor de AI procesa datos en infraestructura fuera de la UE o el EEE, ustedes necesitan un mecanismo de transferencia válido, como Cláusulas Contractuales Estándar o una evaluación de impacto de transferencia. Muchos servicios de AI en la nube enrutan el procesamiento a través de centros de datos en EE. UU. o Asia por defecto.

Es necesario definir períodos de retención para los datos procesados por AI. El GDPR exige que los datos personales no se conserven más tiempo del necesario. Los sistemas de AI que retienen registros de conversaciones, datos de entrada o datos de salida indefinidamente sin un cronograma de retención documentado no cumplen con la normativa, independientemente de otras salvaguardas.

## **Construir una práctica de AI lista para el GDPR**

Las organizaciones que navegan con éxito el GDPR y las herramientas de AI comparten un enfoque común. Evalúan el cumplimiento antes de la implementación en lugar de después, mantienen documentación viva de sus flujos de datos de AI y tratan el cumplimiento del GDPR como una disciplina operativa continua en lugar de un proyecto con una fecha de finalización.

El entorno regulatorio en torno a la AI en Europa se está endureciendo, no relajando. La combinación de un cumplimiento del GDPR cada vez más centrado en la AI y de la Ley de AI de la UE agregando un marco paralelo significa que las organizaciones con bases débiles de gobernanza de AI están acumulando exposición al cumplimiento con cada nueva herramienta que implementan.

Construir esa base no es tan complejo como suena. Mapeen sus flujos de datos. Establezcan bases legales. Documenten su procesamiento. Evalúen sus implementaciones de alto riesgo. Pongan en orden sus acuerdos con proveedores. Estas son prácticas de cumplimiento establecidas aplicadas a una nueva categoría de tecnología. Las organizaciones que lo abordan sistemáticamente descubren que el cumplimiento y la adopción efectiva de AI no están en conflicto. Hechos correctamente, se refuerzan mutuamente.

## **Preguntas frecuentes**

### **¿Las herramientas de AI están sujetas al GDPR?**

**Sí, las herramientas de AI están plenamente sujetas al GDPR siempre que procesen datos personales relacionados con personas en la UE, independientemente de dónde tenga su sede la empresa de AI o dónde se encuentren sus servidores.** La regulación se aplica en función de la ubicación de los interesados, no del proveedor de tecnología, lo que significa que cualquier herramienta de AI utilizada con datos de clientes o empleados europeos debe cumplir.

### **¿Qué es la regla del 30 % para la AI?**

**La regla del 30 % para la AI es una guía práctica que sugiere que la automatización de AI debería cubrir aproximadamente el 30 % de un flujo de trabajo, mientras que el juicio humano y la supervisión manejan el 70 % restante.** En contextos del GDPR, este encuadre es particularmente útil para el cumplimiento del Artículo 22, ya que ayuda a las organizaciones a diseñar implementaciones de AI donde los humanos permanezcan genuinamente involucrados en las decisiones en lugar de simplemente avalar resultados automatizados.

### **¿Cuáles son los cambios en el GDPR para la AI?**

**El GDPR en sí mismo no ha sido modificado formalmente para la AI, pero las autoridades de protección de datos en toda la UE han emitido orientaciones cada vez más específicas que aplican los principios existentes del GDPR a los sistemas de AI, particularmente en torno a las bases legales para los datos de entrenamiento, la toma de decisiones automatizada y los requisitos de transparencia para los resultados generados por AI.** La Ley de AI de la UE, que funciona junto al GDPR en lugar de reemplazarlo, agrega obligaciones adicionales para los sistemas de AI de alto riesgo que procesan datos personales.

### **¿Qué es el Artículo 22 del GDPR y la AI?**

**El Artículo 22 del GDPR otorga a las personas el derecho a no ser objeto de decisiones tomadas únicamente mediante procesamiento automatizado que produzcan efectos legales o similarmente significativos, lo cual se aplica directamente a los sistemas de AI que toman decisiones consecuentes sobre las personas sin una revisión humana significativa.** Las organizaciones que utilizan AI para puntuación crediticia, selección de empleo o acceso a servicios deben asegurarse de que un humano realmente revise las salidas de AI antes de que las decisiones se materialicen, o de que se aplique una de las tres excepciones legales con todas las salvaguardas adicionales requeridas en su lugar.

### **¿Qué es el Artículo 37 del GDPR?**

**El Artículo 37 del GDPR establece el requisito de que ciertas organizaciones designen un Responsable de Protección de Datos, un rol que se vuelve prácticamente esencial para cualquier empresa que ejecute sistemas de AI que procesen grandes volúmenes de datos personales o que participen en monitoreo conductual sistemático.** Las organizaciones cuyas actividades principales de AI involucren perfilado a gran escala, procesamiento de datos de categoría especial o monitoreo sistemático de individuos probablemente activen el requisito obligatorio de designación de DPO bajo este artículo.
