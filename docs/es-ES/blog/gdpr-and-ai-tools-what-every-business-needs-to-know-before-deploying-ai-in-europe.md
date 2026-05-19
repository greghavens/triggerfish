---
title: "GDPR y herramientas de AI: lo que toda empresa debe saber antes de
  implementar AI en Europa"
date: 2026-03-03
description: El GDPR y las herramientas de AI se cruzan en torno al tratamiento
  de datos, el consentimiento y las decisiones automatizadas. Esto es lo que las
  empresas deben entender para cumplir la normativa al implementar AI en Europa.
author: triggerfish
tags:
  - AI agent
draft: false
---



El GDPR y las herramientas de AI se cruzan en un punto crítico para cualquier organización que trate datos personales de residentes europeos mediante sistemas de inteligencia artificial. El reglamento se aplica plenamente a las implantaciones de AI, lo que significa que toda herramienta que recopile, trate o actúe sobre datos personales debe cumplir con los requisitos del GDPR de base jurídica, transparencia y minimización de datos, o se arriesga a una acción ejecutoria importante.

Muchas organizaciones se han movido rápidamente en la adopción de la AI sin detenerse a preguntarse si sus nuevas herramientas son realmente legales bajo la legislación europea de protección de datos. La respuesta no siempre es cómoda. La AI introduce actividades de tratamiento de datos que el GDPR no fue redactado originalmente para abordar, pero que sí cubre absolutamente bajo su marco existente. La elaboración automatizada de perfiles, el tratamiento a gran escala de datos personales, las transferencias transfronterizas de datos provocadas por la infraestructura de AI en la nube y los sistemas opacos de toma de decisiones se encuentran todos dentro del ámbito regulador del GDPR. Entender exactamente dónde recaen las obligaciones y cómo construir implantaciones de AI que las satisfagan ya no es opcional para las empresas que operan o venden en los mercados europeos. Esta guía recorre lo que realmente exige el cumplimiento normativo y dónde la mayoría de los equipos suelen equivocarse.



![Ai agent](/blog/images/flag.jpg)

## **Por qué el GDPR se aplica a las herramientas de AI de forma más amplia de lo que la mayoría de los equipos cree**

### **Cada interacción de AI que implique datos personales es un acto de tratamiento**

El GDPR define el tratamiento de datos de manera amplia. Cualquier operación realizada sobre datos personales, incluida la recogida, conservación, recuperación, uso, comunicación y supresión, queda dentro del ámbito del reglamento. Cuando una herramienta de AI recibe un nombre, una dirección de correo electrónico, un patrón de comportamiento, una grabación de voz o cualquier otra información relacionada con una persona identificable, está tratando datos personales según la definición del GDPR desde el momento en que esos datos entran en el sistema.

Esto pilla a muchas organizaciones desprevenidas porque el modelo mental intuitivo del cumplimiento del GDPR se centra en las bases de datos y el almacenamiento. Si almacenáis registros de clientes, cumplís con las normas de almacenamiento. Pero el tratamiento por AI es tratamiento independientemente de si algo se guarda permanentemente. Una herramienta de AI que analiza una transcripción de atención al cliente para clasificar el sentimiento y descarta inmediatamente la transcripción ha tratado igualmente datos personales. La base jurídica para hacerlo, y las obligaciones de transparencia que la acompañan, se aplican a esa interacción.

La implicación práctica es que vuestra evaluación de cumplimiento del GDPR no puede detenerse en vuestras bases de datos y sistemas CRM. Cada herramienta de AI que utilice vuestra organización debe evaluarse en cuanto a qué datos personales toca, sobre qué base jurídica y bajo qué condiciones.

### **El problema de la base jurídica con las herramientas de AI**

El GDPR exige que toda actividad de tratamiento que implique datos personales tenga una base jurídica válida. Las seis bases disponibles son consentimiento, ejecución de un contrato, obligación legal, intereses vitales, misión de interés público e interés legítimo. Para la mayoría de las implantaciones comerciales de AI, las opciones relevantes son el consentimiento, la ejecución del contrato y el interés legítimo.

El desafío con las herramientas de AI es que las actividades de tratamiento que realizan son a menudo difíciles de describir con suficiente especificidad para satisfacer los requisitos de transparencia del GDPR para el consentimiento o la ponderación del interés legítimo. Decirles a los usuarios que sus datos serán tratados por sistemas de AI para la mejora del servicio no es lo suficientemente específico. Explicar exactamente qué datos fluyen a través de qué sistema de AI, con qué finalidad, conservados durante cuánto tiempo, compartidos con qué encargados del tratamiento y utilizados para fundamentar qué decisiones es lo que el reglamento realmente requiere.

Las organizaciones que no han cartografiado sus flujos de datos de AI en detalle no pueden satisfacer este requisito porque genuinamente no saben qué están divulgando. El trabajo de cumplimiento y el trabajo de transparencia son el mismo trabajo.


<table>
  <thead>
    <tr>
      <th>Base jurídica</th>
      <th>Cuándo se aplica a la AI</th>
      <th>Requisito clave</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Consentimiento</td>
      <td>Tratamiento de AI no necesario para el servicio, claramente opcional</td>
      <td>Otorgado libremente, específico, informado, inequívoco</td>
    </tr>
    <tr>
      <td>Ejecución del contrato</td>
      <td>AI directamente necesaria para prestar un servicio contratado</td>
      <td>Tratamiento limitado a lo que el contrato requiere</td>
    </tr>
    <tr>
      <td>Interés legítimo</td>
      <td>Existe un beneficio empresarial y no prevalece sobre los derechos individuales</td>
      <td>Evaluación del interés legítimo documentada</td>
    </tr>
    <tr>
      <td>Obligación legal</td>
      <td>AI utilizada para cumplir con un requisito legal</td>
      <td>Debe existir y documentarse una obligación legal específica</td>
    </tr>
    <tr>
      <td>Misión de interés público</td>
      <td>Autoridades públicas y organizaciones con mandatos públicos</td>
      <td>Debe basarse en el Derecho de la Unión o de los Estados miembros</td>
    </tr>
  </tbody>
</table>



Alinear la documentación de[ AI security](https://trigger.fish/security/) y la base jurídica desde el inicio de una implantación evita la situación en la que tenéis un sistema de AI técnicamente seguro funcionando sobre una base jurídicamente inestable.



![AI agent](/blog/images/legal-compliance.jpg)

## **Lo que los cambios del GDPR significan específicamente para la AI**

### **La interpretación reguladora en evolución**

El GDPR se finalizó en 2016 y entró en vigor en 2018, anticipándose en varios años a la generación actual de grandes modelos de lenguaje. El texto del reglamento no menciona la AI generativa, los modelos fundacionales ni las canalizaciones de inferencia. Lo que sí contiene es un marco basado en principios lo bastante amplio para abarcar estas tecnologías, y las autoridades de protección de datos de los Estados miembros de la UE han ido emitiendo de manera constante directrices que aclaran cómo se aplican esos principios.

La acción ejecutoria de la autoridad italiana de protección de datos contra ChatGPT en 2023 fue la señal más clara de que los reguladores estaban dispuestos a actuar sobre preocupaciones del GDPR específicas de la AI. La acción se centró en la falta de una base jurídica clara de OpenAI para tratar los datos de los usuarios italianos, la ausencia de mecanismos de verificación de edad y la transparencia insuficiente sobre cómo se usaban los datos personales en el entrenamiento del modelo. La herramienta fue suspendida temporalmente en Italia y restablecida solo después de que OpenAI realizara cambios concretos de cumplimiento.

Otras autoridades nacionales de protección de datos de toda la UE han emitido desde entonces directrices que abordan los datos de entrenamiento de AI, la toma de decisiones automatizada y las condiciones bajo las cuales los resultados generados por AI constituyen tratamiento de datos personales sobre las personas cuyos datos se usaron para entrenar el modelo.

La dirección del rumbo es clara. La ejecución del GDPR avanza más profundamente en territorio específico de la AI, y las organizaciones que han tratado el cumplimiento de la AI como un problema futuro están descubriendo que se ha convertido en un problema presente.

### **Cómo la Ley de AI de la UE se superpone al GDPR**

La Ley de AI de la UE, que entró en vigor en 2024, añade una capa reguladora paralela que funciona junto al GDPR en lugar de reemplazarlo. Donde el GDPR rige lo que ocurre con los datos personales, la Ley de AI rige las características y el comportamiento de los propios sistemas de AI, en particular los clasificados como de alto riesgo.

Para las empresas que implantan herramientas de AI que interactúan con datos personales, ambos marcos se aplican simultáneamente. Un sistema de AI utilizado en la selección laboral, la evaluación crediticia o el triaje sanitario está sujeto a los requisitos de la Ley de AI sobre transparencia, supervisión humana y exactitud, al tiempo que está sujeto a los requisitos del GDPR para cada dato personal que trata.

Entender cómo las decisiones de[ AI architecture](https://trigger.fish/architecture/) afectan al cumplimiento bajo ambos marcos ayuda a las organizaciones a diseñar sistemas que satisfagan el panorama regulador completo en lugar de optimizar para una norma a expensas de la otra.

## **El Artículo 22 y la toma de decisiones automatizada**

### **Lo que el Artículo 22 prohíbe realmente**

El Artículo 22 del GDPR otorga a las personas el derecho a no ser objeto de decisiones basadas únicamente en el tratamiento automatizado, incluida la elaboración de perfiles, que produzcan efectos jurídicos o le afecten significativamente de modo similar. Esta es una de las disposiciones más directamente relevantes para la AI del reglamento y una de las más comúnmente malinterpretadas.

La prohibición no es sobre el uso de AI en los procesos de toma de decisiones. Es específicamente sobre decisiones tomadas únicamente por sistemas automatizados donde ningún humano revisa significativamente el resultado antes de que afecte a la persona. Una AI de puntuación crediticia que genera una recomendación que un responsable de préstamos humano considera y confirma o anula no activa el Artículo 22. Un sistema que aprueba o rechaza automáticamente solicitudes de préstamo a partir de la salida algorítmica sin un humano en el bucle de decisión sí lo hace.

Para las herramientas de AI utilizadas en RRHH, segmentación de clientes, detección de fraude y contextos similares, el análisis del Artículo 22 es esencial. Si vuestra herramienta de AI toma decisiones que afectan al acceso de las personas a servicios, oportunidades de empleo o productos financieros, y ningún humano revisa realmente esas decisiones antes de que se materialicen, tenéis un problema de cumplimiento del Artículo 22.

Las tres excepciones al Artículo 22 son la necesidad contractual, el consentimiento explícito y la autorización legal. Cada una exige condiciones adicionales específicas, incluido el derecho a la revisión humana, el derecho a impugnar la decisión y el derecho a obtener una explicación de la lógica involucrada.


<table>
  <thead>
    <tr>
      <th>Tipo de decisión automatizada</th>
      <th>¿Se activa el Artículo 22?</th>
      <th>Vía de cumplimiento</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Recomendación de AI revisada por un humano antes de actuar</td>
      <td>No</td>
      <td>Se aplican las obligaciones estándar de tratamiento del GDPR</td>
    </tr>
    <tr>
      <td>Aprobación o rechazo totalmente automatizado con efecto jurídico</td>
      <td>Sí</td>
      <td>Debe ampararse en una excepción con derecho a revisión humana</td>
    </tr>
    <tr>
      <td>Elaboración automatizada de perfiles para segmentar listas de marketing</td>
      <td>Depende de la importancia</td>
      <td>Evaluar si los efectos son jurídicamente significativos</td>
    </tr>
    <tr>
      <td>Puntuación de contenido generada por AI que influye en una decisión laboral</td>
      <td>Sí</td>
      <td>Excepción de contrato o consentimiento más revisión humana</td>
    </tr>
    <tr>
      <td>Alerta de fraude que requiere investigación humana antes de actuar sobre la cuenta</td>
      <td>No</td>
      <td>La revisión humana rompe la cadena únicamente automatizada</td>
    </tr>
  </tbody>
</table>



Revisar las[ AI features](https://trigger.fish/features/) en las herramientas que estáis considerando implantar ayuda a identificar cuáles incorporan puntos de control humanos significativos y cuáles encaminan decisiones automáticamente sin revisión humana.



![AI agent](/blog/images/a-person.jpg)

## **El Artículo 37 y el requisito del Delegado de Protección de Datos**

### **Cuándo las implantaciones de AI requieren un DPO**

El Artículo 37 del GDPR exige que ciertas organizaciones designen un Delegado de Protección de Datos. El requisito se aplica a las autoridades y organismos públicos, a las organizaciones cuyas actividades principales requieran la observación sistemática a gran escala de personas y a las organizaciones cuyas actividades principales impliquen el tratamiento a gran escala de categorías especiales de datos o datos relativos a condenas penales.

Las herramientas de AI activan frecuentemente esta evaluación. Una empresa minorista que implanta AI para análisis del comportamiento en millones de interacciones con clientes está realizando observación sistemática a gran escala. Una organización sanitaria que utiliza AI para tratar historiales de pacientes a escala está tratando datos de categoría especial a gran escala. Ambos escenarios apuntan a un requisito obligatorio de DPO.

Incluso cuando el requisito del DPO no es estrictamente obligatorio, la función que cumple, supervisión de las actividades de tratamiento de datos, enlace con autoridades de control y asesoramiento independiente sobre cumplimiento, es prácticamente esencial para las organizaciones que ejecutan sistemas de AI que tocan volúmenes significativos de datos personales. Muchas empresas que no están técnicamente obligadas a designar un DPO lo hacen porque el valor operativo lo justifica.

El DPO debe involucrarse en las implantaciones de AI antes de que entren en funcionamiento, no consultarse posteriormente cuando surjan problemas. Incluir al DPO en el proceso de evaluación de herramientas, la Evaluación de Impacto relativa a la Protección de Datos y la revisión del acuerdo con el proveedor crea el rastro documentado de supervisión que los reguladores esperan ver.

### **Evaluaciones de Impacto relativas a la Protección de Datos para la AI**

El Artículo 35 del GDPR exige una Evaluación de Impacto relativa a la Protección de Datos antes de implantar cualquier tratamiento que pueda entrañar un alto riesgo para las personas. Los sistemas de AI que implican elaboración de perfiles a gran escala, observación sistemática o toma de decisiones automatizada con efectos significativos casi siempre activan este requisito.

Una EIPD adecuada para una herramienta de AI cubre qué datos personales trata el sistema y por qué, la necesidad y proporcionalidad del tratamiento, los riesgos para las personas y cómo se mitigarán, y las medidas adoptadas para demostrar el cumplimiento. No es un documento único. Cuando la herramienta de AI cambia, cuando las entradas de datos cambian o cuando el contexto empresarial cambia sustancialmente, hay que revisitar la EIPD.

Una[ AI guide](https://trigger.fish/guide/) práctica sobre la metodología de EIPD para sistemas de AI ayuda a los equipos de cumplimiento a estructurar evaluaciones que satisfagan las expectativas de la autoridad de control en lugar de producir documentación que parezca exhaustiva pero pase por alto el análisis sustantivo del riesgo que los reguladores buscan.

## **Cosas que conviene saber**

Varios puntos importantes sobre el GDPR y las herramientas de AI que tienden a aflorar solo después de que ya hayan ocurrido problemas:

Entrenar modelos de AI con datos personales requiere su propia evaluación de la base jurídica. Si estáis afinando un modelo con datos de clientes, datos de empleados o cualquier otro dato personal que posea vuestra organización, esa actividad de entrenamiento es una finalidad de tratamiento distinta que necesita su propia base jurídica, separada de la finalidad original de recogida.

Los derechos del interesado se aplican a los datos tratados por AI. Las personas conservan el derecho a acceder, rectificar, suprimir y portar sus datos personales aunque hayan sido tratados por un sistema de AI. Si vuestra herramienta de AI no puede sustentar estos derechos operativamente, eso es una brecha de cumplimiento independientemente de lo buenos que sean los demás controles de seguridad de la herramienta.

Encargados y subencargados del tratamiento deben estar documentados. Cada proveedor de AI que trate datos personales por cuenta vuestra debe figurar en vuestro Registro de Actividades de Tratamiento. Sus subencargados, los proveedores de infraestructura, las empresas de alojamiento y otros proveedores en los que se apoyen, deben divulgarse en vuestros Acuerdos de Tratamiento de Datos con ellos.

La seudonimización reduce el riesgo, pero no elimina las obligaciones del GDPR. Los datos que han sido seudonimizados, es decir, los identificadores han sido sustituidos por códigos, siguen siendo datos personales bajo el GDPR si la reidentificación es razonablemente posible. Las herramientas de AI que tratan datos seudonimizados siguen tratando datos personales.

Las transferencias transfronterizas provocadas por la infraestructura de AI requieren mecanismos de transferencia. Si vuestro proveedor de AI trata datos en infraestructura fuera de la UE o el EEE, necesitáis un mecanismo de transferencia válido, como las Cláusulas Contractuales Tipo o una evaluación de impacto de la transferencia. Muchos servicios de AI en la nube encaminan el tratamiento a través de centros de datos en EE. UU. o Asia por defecto.

Hay que definir plazos de conservación para los datos tratados por AI. El GDPR exige que los datos personales no se conserven más tiempo del necesario. Los sistemas de AI que conservan registros de conversaciones, datos de entrada o datos de salida indefinidamente sin un calendario de conservación documentado no son conformes, independientemente de otras salvaguardas.

## **Construir una práctica de AI lista para el GDPR**

Las organizaciones que navegan con éxito el GDPR y las herramientas de AI comparten un enfoque común. Evalúan el cumplimiento antes de la implantación en lugar de después, mantienen documentación viva de sus flujos de datos de AI y tratan el cumplimiento del GDPR como una disciplina operativa continua en lugar de un proyecto con fecha de finalización.

El entorno regulador en torno a la AI en Europa se está endureciendo, no relajando. La combinación de una ejecución del GDPR cada vez más centrada en la AI y la Ley de AI de la UE añadiendo un marco paralelo significa que las organizaciones con bases débiles de gobernanza de la AI están acumulando exposición al cumplimiento con cada nueva herramienta que implantan.

Construir esa base no es tan complejo como suena. Cartografiad vuestros flujos de datos. Estableced bases jurídicas. Documentad vuestro tratamiento. Evaluad vuestras implantaciones de alto riesgo. Poned en orden vuestros acuerdos con proveedores. Estas son prácticas de cumplimiento consolidadas aplicadas a una nueva categoría de tecnología. Las organizaciones que lo abordan sistemáticamente descubren que el cumplimiento y la adopción eficaz de AI no están reñidos. Hechos correctamente, se refuerzan mutuamente.

## **Preguntas frecuentes**

### **¿Las herramientas de AI están sujetas al GDPR?**

**Sí, las herramientas de AI están plenamente sujetas al GDPR siempre que traten datos personales relativos a personas en la UE, con independencia de dónde tenga su sede la empresa de AI o dónde se encuentren sus servidores.** El reglamento se aplica en función de la ubicación de los interesados, no del proveedor de tecnología, lo que significa que cualquier herramienta de AI utilizada con datos de clientes o empleados europeos debe cumplir.

### **¿Qué es la regla del 30 % para la AI?**

**La regla del 30 % para la AI es una orientación práctica que sugiere que la automatización por AI debería cubrir aproximadamente el 30 % de un flujo de trabajo, mientras que el juicio humano y la supervisión gestionan el 70 % restante.** En contextos del GDPR, este planteamiento resulta especialmente útil para el cumplimiento del Artículo 22, ya que ayuda a las organizaciones a diseñar implantaciones de AI donde los humanos sigan estando realmente implicados en las decisiones en lugar de limitarse a refrendar resultados automatizados.

### **¿Cuáles son los cambios del GDPR para la AI?**

**El GDPR como tal no ha sido modificado formalmente para la AI, pero las autoridades de protección de datos de toda la UE han emitido directrices cada vez más específicas que aplican los principios existentes del GDPR a los sistemas de AI, especialmente en torno a las bases jurídicas de los datos de entrenamiento, la toma de decisiones automatizada y los requisitos de transparencia para los resultados generados por AI.** La Ley de AI de la UE, que funciona junto al GDPR en lugar de reemplazarlo, añade obligaciones adicionales para los sistemas de AI de alto riesgo que tratan datos personales.

### **¿Qué es el Artículo 22 del GDPR y la AI?**

**El Artículo 22 del GDPR otorga a las personas el derecho a no ser objeto de decisiones basadas únicamente en tratamiento automatizado que produzcan efectos jurídicos o le afecten significativamente de modo similar, lo cual se aplica directamente a los sistemas de AI que toman decisiones consecuentes sobre las personas sin una revisión humana significativa.** Las organizaciones que utilizan AI para puntuación crediticia, selección laboral o acceso a servicios deben asegurarse de que un humano revise realmente las salidas de la AI antes de que las decisiones se materialicen, o de que se aplique una de las tres excepciones legales con todas las salvaguardas adicionales requeridas en su lugar.

### **¿Qué es el Artículo 37 del GDPR?**

**El Artículo 37 del GDPR establece el requisito de que ciertas organizaciones designen un Delegado de Protección de Datos, una figura que resulta prácticamente esencial para cualquier empresa que opere sistemas de AI que traten grandes volúmenes de datos personales o realicen observación sistemática del comportamiento.** Las organizaciones cuyas actividades principales de AI impliquen elaboración de perfiles a gran escala, tratamiento de datos de categoría especial u observación sistemática de individuos probablemente activarán el requisito obligatorio de designación de DPO bajo este artículo.
