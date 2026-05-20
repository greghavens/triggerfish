---
title: ¿Qué es la AI RAG? La tecnología que hace que los modelos de lenguaje sean realmente
  útiles para las empresas
date: 2026-03-25
description: ¿Qué es la AI RAG? La Generación Aumentada por Recuperación conecta los modelos de AI
  con fuentes de datos en vivo, haciendo que las respuestas sean más precisas y actuales que lo que pueden
  ofrecer los LLM estándar por sí solos.
author: triggerfish
tags:
  - AI agent
draft: false
---


¿Qué es la AI RAG? La Generación Aumentada por Recuperación es una técnica que conecta un modelo de lenguaje grande con una fuente de conocimiento externa en el momento en que genera una respuesta, permitiendo que el modelo incorpore información actual, específica y verificable en lugar de depender únicamente de lo que aprendió durante el entrenamiento. El resultado es un sistema de AI que responde preguntas con datos reales en lugar de aproximaciones generalizadas.

Si alguna vez le hicieron una pregunta a un asistente de AI estándar sobre los procesos internos de su empresa y recibieron una respuesta que sonaba razonable pero que estaba completamente inventada, ya experimentaron la limitación central que RAG fue diseñada para resolver. Los modelos de lenguaje se entrenan con datos hasta un punto fijo en el tiempo. No saben nada sobre su documentación propietaria, su inventario actual, sus políticas más recientes o cualquier cosa que haya ocurrido después de su fecha de corte de entrenamiento. RAG cambia esa limitación fundamental al darle al modelo un mecanismo para buscar información antes de responder, de la misma manera que un analista bien preparado consulta documentos fuente antes de dar consejos en lugar de trabajar enteramente de memoria. Para las empresas que despliegan AI en contextos donde la precisión y la especificidad importan, comprender qué es la AI RAG y cómo funciona no es un detalle técnico. Es la diferencia entre una AI que realmente ayuda y una que produce con confianza tonterías plausibles.



![AI agent](/blog/images/clean-illustration.jpg)

## **Por qué los modelos de lenguaje estándar tienen un problema fundamental de conocimiento**

### **La limitación del corte de entrenamiento**

Cada modelo de lenguaje grande que existe hoy fue entrenado con un conjunto de datos con una fecha de finalización definida. Todo lo que sucedió después de esa fecha, cada cambio de política, cada actualización de producto, cada desarrollo regulatorio, cada pieza de conocimiento organizacional creada desde que el modelo fue entrenado, es invisible para él. Para tareas de conocimiento general, esta limitación es manejable porque el conocimiento fundamental cambia lentamente. Para aplicaciones empresariales donde la precisión sobre información actual y específica es el objetivo completo, es un problema operativo serio.

La segunda limitación es el alcance. Incluso los modelos de lenguaje más grandes entrenados con los conjuntos de datos más amplios posibles no tienen conocimiento de información que nunca estuvo en sus datos de entrenamiento. La base de conocimiento interna de su empresa, sus contratos con clientes, su documentación técnica, sus estructuras de precios y sus procedimientos operativos casi con certeza nunca estuvieron en ningún conjunto de datos de entrenamiento público. Un modelo que responde preguntas sobre estos temas no está recuperando información que conoce. Está generando texto que suena como una respuesta basada en patrones de su entrenamiento, un proceso que produce respuestas fluidas y seguras que pueden no tener relación con los hechos reales.

Este fenómeno tiene un nombre en la investigación de AI: alucinación. Describe la tendencia de los modelos de lenguaje a generar información factualmente incorrecta presentada con el mismo tono confiado que la información precisa. Para casos de uso casuales, la alucinación es una molestia. Para aplicaciones empresariales en contextos legales, médicos, financieros u operativos, es una responsabilidad.

### **Cómo RAG aborda ambos problemas a la vez**

¿Qué resuelve específicamente la AI RAG? Aborda tanto el problema del corte como el problema del alcance con una sola adición arquitectónica. En lugar de pedirle al modelo que responda solo con los datos de entrenamiento, los sistemas RAG recuperan documentos o datos relevantes de una fuente externa en el momento de la consulta e incluyen ese contenido recuperado en el contexto que el modelo usa para generar su respuesta.

El modelo no está adivinando lo que dice su política de reembolso. Recuperó el documento de política real antes de responder. No está estimando cuáles fueron las cifras de ingresos del Q3. Extrajo las cifras reales de su sistema financiero antes de responder. El rol del modelo cambia de única fuente de conocimiento a sintetizador inteligente de información recuperada, que es una tarea que los modelos de lenguaje hacen extraordinariamente bien.

Este cambio arquitectónico tiene implicaciones que van mucho más allá de arreglar las alucinaciones. Significa que los sistemas de AI pueden actualizarse actualizando sus fuentes de conocimiento en lugar de reentrenar sus modelos. Significa que las respuestas pueden citar sus fuentes, lo que facilita la verificación. Y significa que las organizaciones pueden construir sistemas de AI con acceso a conocimiento interno genuinamente sensible sin que ese conocimiento tenga que ser incluido en un conjunto de datos de entrenamiento.

## **Cómo funciona realmente la AI RAG**

### **El pipeline de recuperación explicado**

Un sistema RAG tiene dos componentes principales que trabajan en secuencia antes de que el modelo de lenguaje genere una sola palabra de su respuesta.

El primer componente es la base de conocimiento y su infraestructura de indexación. Los documentos, registros, páginas web, entradas de bases de datos o cualquier otra información de la que la AI deba poder obtener datos se procesan y almacenan de una manera que los hace buscables por significado en lugar de solo por palabra clave. Esto típicamente implica convertir texto en representaciones numéricas llamadas embeddings, que capturan el significado semántico en una forma que permite que el contenido matemáticamente similar se recupere junto. Una pregunta sobre procesos de reembolso de clientes recupera contenido sobre devoluciones, intercambios y garantías de satisfacción incluso si esas palabras exactas no aparecen en la consulta.

El segundo componente es el mecanismo de recuperación que se activa cuando un usuario envía una consulta. La consulta se convierte al mismo formato de embedding que los documentos almacenados, y el sistema identifica el contenido almacenado más semánticamente similar a la consulta. Ese contenido recuperado, los pasajes, documentos o registros más relevantes para la pregunta que se hace, se ensambla y se pasa al modelo de lenguaje junto con la consulta original.

El modelo de lenguaje genera entonces una respuesta basada en ese contexto recuperado en lugar de depender de sus datos de entrenamiento para los hechos específicos requeridos. Los datos de entrenamiento siguen siendo importantes para la capacidad lingüística del modelo, su capacidad de razonamiento y su conocimiento general del mundo. Pero el contenido factual específico de la respuesta proviene del material recuperado.


<table>
  <thead>
    <tr>
      <th>Componente del sistema RAG</th>
      <th>Qué hace</th>
      <th>Por qué importa</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Ingesta de documentos</td>
      <td>Procesa y fragmenta documentos fuente para indexación</td>
      <td>Determina a qué conocimiento puede acceder el sistema</td>
    </tr>
    <tr>
      <td>Modelo de embeddings</td>
      <td>Convierte texto en representaciones vectoriales semánticas</td>
      <td>Permite la recuperación basada en significado en lugar de coincidencia de palabras clave</td>
    </tr>
    <tr>
      <td>Base de datos vectorial</td>
      <td>Almacena embeddings para búsqueda rápida de similitud</td>
      <td>Hace que la recuperación sea lo suficientemente rápida para uso en tiempo real</td>
    </tr>
    <tr>
      <td>Mecanismo de recuperación</td>
      <td>Identifica el contenido más relevante para cada consulta</td>
      <td>Determina la precisión del contexto recuperado</td>
    </tr>
    <tr>
      <td>Modelo de lenguaje</td>
      <td>Genera respuesta basada en el contenido recuperado</td>
      <td>Produce salida coherente y sintetizada a partir de los hechos recuperados</td>
    </tr>
    <tr>
      <td>Atribución de fuentes</td>
      <td>Rastrea qué documentos informaron cada respuesta</td>
      <td>Permite la verificación y genera confianza en el usuario</td>
    </tr>
  </tbody>
</table>



Entender cómo las decisiones de[ arquitectura de AI](https://trigger.fish/architecture/) en los pipelines RAG afectan tanto la calidad de la recuperación como la precisión de la respuesta ayuda a las organizaciones a construir sistemas que funcionen de manera confiable en lugar de bien en demostraciones e inconsistentes en producción.

![AI agent](/blog/images/process-step.jpg)

## **RAG vs LLM estándar: dónde aparece la diferencia en la práctica**

La distinción entre lo que es la AI RAG y lo que hace un LLM estándar se vuelve más visible en los escenarios específicos donde los modelos estándar fallan y los sistemas RAG tienen éxito.

A un LLM estándar al que se le pregunta sobre la política actual de retención de datos de su organización, genera una respuesta basada en prácticas comunes de retención de datos de sus datos de entrenamiento. Puede sonar exactamente correcto. Casi con certeza no está describiendo su política real. A un sistema RAG al que se le hace la misma pregunta, recupera su documento de política real y genera una respuesta basada en lo que dice ese documento. El lenguaje es similar. La precisión es categóricamente diferente.

A un LLM estándar al que se le pregunta sobre una queja de cliente presentada ayer, no tiene idea de lo que están hablando. La queja es posterior a su entrenamiento. Un sistema RAG conectado a su CRM recupera el registro de la queja y genera una respuesta que refleja los detalles reales de la situación específica de ese cliente.

A un LLM estándar al que se le pide que resuma los hallazgos clave de un informe de investigación que ustedes subieron, puede producir un resumen que suena plausible pero que omite hallazgos críticos, tergiversa conclusiones o combina detalles de diferentes partes del documento de manera inexacta. Un sistema RAG recupera las secciones específicas más relevantes para la solicitud de resumen y genera resultados basados en el texto real.


<table>
  <thead>
    <tr>
      <th>Escenario</th>
      <th>Respuesta de LLM estándar</th>
      <th>Respuesta de AI RAG</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Pregunta sobre política interna</td>
      <td>Genera una respuesta genérica plausible no específica para sus políticas</td>
      <td>Recupera el documento de política real, responde desde su contenido</td>
    </tr>
    <tr>
      <td>Pregunta sobre evento reciente</td>
      <td>Indica que no tiene información o genera una respuesta desactualizada</td>
      <td>Recupera información actual de la base de conocimiento conectada</td>
    </tr>
    <tr>
      <td>Consulta específica de cliente</td>
      <td>No puede acceder a datos individuales de clientes</td>
      <td>Recupera registros de clientes relevantes y responde con precisión</td>
    </tr>
    <tr>
      <td>Consulta de documentación técnica</td>
      <td>Puede alucinar detalles técnicos</td>
      <td>Recupera secciones específicas de documentación y las cita</td>
    </tr>
    <tr>
      <td>Inteligencia competitiva</td>
      <td>Limitado a los datos de entrenamiento, a menudo desactualizado</td>
      <td>Recupera información actual de las fuentes conectadas</td>
    </tr>
    <tr>
      <td>Pregunta de cumplimiento</td>
      <td>Responde desde conocimiento regulatorio general</td>
      <td>Recupera las reglas aplicables y los procedimientos específicos de la organización</td>
    </tr>
  </tbody>
</table>



## **Dónde están desplegando las empresas la AI RAG con mayor eficacia**

### **Gestión del conocimiento interno**

El caso de uso de gestión del conocimiento interno es donde la AI RAG entrega algunos de sus valores empresariales más claros. La mayoría de las organizaciones tienen un conocimiento institucional sustancial distribuido en repositorios de documentación, wikis, archivos de proyectos pasados, documentos de políticas y comunicaciones que los empleados pasan tiempo significativo buscando manualmente. Un sistema RAG sobre esa base de conocimiento la convierte en un recurso conversacional que el personal puede consultar en lenguaje natural y recibir respuestas precisas y con fuentes.

El valor compuesto aquí es sustancial. Los empleados experimentados que tienen conocimiento organizacional en sus cabezas eventualmente se van. La documentación que existe pero es difícil de encontrar es funcionalmente casi tan inaccesible como la documentación que no existe. Los sistemas RAG hacen que el conocimiento organizacional sea accesible para todo el personal sin importar su antigüedad, reducen el tiempo dedicado a buscar información y sacan a la luz conocimiento relevante en el contexto donde se necesita en lugar de requerir que los empleados sepan dónde buscar.

Revisar cómo las[ funciones de AI](https://trigger.fish/features/) en las plataformas RAG empresariales manejan el control de acceso al contenido recuperado es esencial para este caso de uso porque no todo el conocimiento organizacional debe ser igualmente accesible para todos los empleados. Un sistema RAG bien configurado recupera solo el contenido al que el usuario que consulta está autorizado a acceder, no todo lo que hay en la base de conocimiento.

### **Soporte y servicio al cliente**

Las aplicaciones de servicio al cliente impulsadas por RAG representan uno de los despliegues comercialmente más impactantes de esta tecnología. Una AI de servicio al cliente respaldada por un pipeline RAG sobre la documentación de su producto, guías de solución de problemas, sistema de gestión de pedidos y base de datos de políticas puede responder preguntas específicas y precisas sobre la situación real de un cliente en lugar de generar respuestas genéricas que envían a los clientes a agentes humanos por la información específica que necesitaban.

El caso empresarial es sencillo. La resolución precisa en el primer contacto reduce los costos de soporte, reduce las escalaciones a agentes humanos y produce mejores resultados para los clientes. La base técnica que hace posible la resolución precisa en el primer contacto para los sistemas de AI es casi siempre RAG. Sin recuperación, el modelo no puede acceder a la información actual y específica del cliente que requieren las respuestas de soporte precisas.

### **Aplicaciones de cumplimiento y regulación**

Los servicios financieros, la atención médica, el sector legal y otras industrias altamente reguladas están desplegando AI RAG sobre conjuntos de documentos regulatorios para ayudar a los equipos de cumplimiento a navegar conjuntos de reglas complejas y frecuentemente actualizadas de manera más eficiente. Un oficial de cumplimiento que puede consultar un sistema RAG sobre el texto completo de las regulaciones aplicables, documentos de orientación y marcos de política interna y recibir respuestas precisas y con fuentes a preguntas específicas de cumplimiento trabaja de manera más eficiente y con más confianza que uno que depende de la memoria o la revisión manual de documentos.

La capacidad de citación de los sistemas RAG es particularmente valiosa en contextos de cumplimiento. Una respuesta que cita el párrafo regulatorio específico del que se basa es verificable y defendible de una manera que una respuesta generada por AI sin fuentes no lo es. Esa diferencia importa enormemente cuando la respuesta informa una decisión con consecuencias regulatorias.

Entender cómo se aplican los requisitos de[ seguridad de AI](https://trigger.fish/security/) a los sistemas RAG conectados a datos regulatorios y de cumplimiento sensibles ayuda a las organizaciones a construir pipelines de recuperación que mantengan controles de acceso apropiados en los documentos que indexan.



![AI agent](/blog/images/legal-professinal.jpg)

## **Construir un sistema RAG que realmente funcione**

### **El problema de calidad de datos que la mayoría de los proyectos subestiman**

Los sistemas RAG son tan buenos como el contenido del que recuperan. Las organizaciones que se apresuran a pasar la evaluación de calidad de datos para llegar a la parte emocionante de construir la interfaz de AI descubren consistentemente que la calidad de la recuperación determina la calidad de la respuesta mucho más que la elección del modelo de lenguaje. Documentos fuente deficientes, contenido desactualizado, información formateada de manera inconsistente y bases de conocimiento que no se han mantenido producen sistemas RAG que recuperan el contenido incorrecto y generan respuestas basadas en información mala en lugar de ninguna información.

La implicación práctica es que la preparación de la base de conocimiento no es un paso preliminar para completar rápidamente antes de que comience el trabajo real. Es una parte central del proyecto que determina si el sistema desplegado es útil. La revisión de calidad del documento, la evaluación de la actualidad del contenido, la deduplicación de versiones conflictivas y el mapeo de control de acceso deben ocurrir todos antes de construir la infraestructura de indexación.

### **La estrategia de fragmentación afecta todo lo posterior**

Cómo se dividen los documentos fuente en unidades recuperables antes de la indexación tiene un efecto mayor en la calidad de la recuperación de lo que la mayoría de los equipos se dan cuenta cuando comienzan a construir sistemas RAG. Los fragmentos que son demasiado pequeños pierden la información contextual que hace que su contenido sea significativo. Los fragmentos que son demasiado grandes recuperan más de lo relevante y diluyen la señal que el modelo de lenguaje usa para generar respuestas precisas. La estrategia óptima de fragmentación depende de los tipos de documentos en la base de conocimiento, la naturaleza de las consultas típicas y la ventana de contexto del modelo de lenguaje que se está utilizando.

Probar la calidad de la recuperación con consultas representativas antes de desplegar a los usuarios revela problemas de fragmentación cuando todavía pueden abordarse en lugar de después de que los usuarios hayan experimentado calidad de respuesta inconsistente.

Una[ guía de AI](https://trigger.fish/guide/) integral sobre la metodología de implementación de RAG ayuda a las organizaciones a estructurar su proceso de construcción en torno a las decisiones que más afectan la calidad de producción en lugar de las que son más técnicamente interesantes durante el desarrollo.

## **Cosas que deben saber**

Varias realidades importantes sobre la AI RAG que las organizaciones típicamente descubren durante o después de su primer despliegue:

La calidad de la recuperación y la calidad de la generación son problemas separados que requieren evaluación separada. Un sistema RAG puede recuperar el contenido correcto y generar una respuesta mal sintetizada, o recuperar el contenido incorrecto y generar una respuesta fluida que suena precisa pero no lo es. Probar ambos componentes de manera independiente antes de evaluar el rendimiento del sistema de extremo a extremo identifica dónde viven realmente los problemas.

RAG no elimina la alucinación, la reduce. Un modelo de lenguaje que genera una respuesta a partir del contexto recuperado todavía puede producir contenido inexacto al malinterpretar el material recuperado, combinar información incorrectamente o generar detalles no presentes en el contexto recuperado. El riesgo de alucinación es sustancialmente menor con una buena recuperación que sin ella, pero la revisión humana sigue siendo importante para aplicaciones de alto riesgo.

La elección del modelo de embeddings afecta significativamente la calidad de la recuperación. Los diferentes modelos de embeddings funcionan mejor en diferentes tipos de contenido. Un modelo optimizado para la recuperación de texto general puede funcionar mal en documentación técnica, lenguaje legal o terminología específica del dominio. Probar la calidad de recuperación con los tipos reales de documentos y patrones de consulta antes de comprometerse con un modelo de embeddings previene una rearquitectura costosa más tarde.

El mantenimiento de la base de conocimiento es una función operativa continua, no una tarea de configuración única. A medida que se actualizan los documentos fuente, se agrega nuevo contenido y el contenido desactualizado se vuelve engañoso, la base de conocimiento RAG debe actualizarse en consecuencia. Las organizaciones que tratan la indexación inicial como la finalización del trabajo de la base de conocimiento terminan con sistemas cuya precisión se degrada a medida que se amplía la brecha entre el contenido indexado y la realidad actual.

Los controles de acceso deben aplicarse en el momento de la recuperación, no solo en la ingesta de la base de conocimiento. Un usuario que no debería ver ciertos documentos no debería recibir respuestas basadas en esos documentos incluso si los documentos están indexados en el sistema. La aplicación de permisos en el momento de la recuperación es un requisito de seguridad, no una mejora opcional.

La regla del 30% se aplica útilmente a la planificación de despliegues de RAG. La recuperación y síntesis de AI deben manejar aproximadamente el 30% del trabajo de conocimiento, el componente de búsqueda y síntesis, mientras que la experiencia humana maneja el juicio, la interpretación y la toma de decisiones consecuentes que constituye el 70% restante. Diseñar despliegues de RAG en torno a este equilibrio crea sistemas que genuinamente aumentan el trabajo de conocimiento humano en lugar de intentar reemplazar el juicio que aún debe quedar con las personas.

## **Por qué la AI RAG se está convirtiendo en la arquitectura estándar para la AI empresarial**

¿Qué es la AI RAG en el contexto más amplio de la adopción de AI empresarial? Es el patrón arquitectónico que hace que los modelos de lenguaje sean prácticamente útiles para las tareas específicas, actuales y de conocimiento organizacional que las empresas realmente necesitan que la AI maneje. La combinación de la capacidad de un modelo de lenguaje para razonar, sintetizar y comunicarse en lenguaje natural con el acceso de un sistema de recuperación a información actual, específica y verificable produce algo que ninguno de los componentes entrega por sí solo.

Las organizaciones que han desplegado modelos de lenguaje estándar y se han decepcionado por las alucinaciones, el conocimiento desactualizado y la incapacidad de manejar preguntas específicas de la empresa a menudo están desplegando la tecnología correcta en la arquitectura incorrecta. Los mismos modelos, conectados a pipelines de recuperación bien construidos sobre bases de conocimiento bien mantenidas, producen resultados dramáticamente diferentes y dramáticamente más útiles.

La barrera técnica para construir sistemas RAG ha bajado significativamente en los últimos dos años. Los frameworks, bases de datos vectoriales e infraestructura de recuperación alojada que hacen que RAG sea práctico son maduros, están bien documentados y son accesibles para los equipos de ingeniería sin antecedentes especializados en investigación de AI. Lo que separa los despliegues exitosos de RAG de los decepcionantes tiene menos que ver con la sofisticación técnica y más con la disciplina organizacional para preparar las bases de conocimiento adecuadamente, evaluar la calidad de la recuperación rigurosamente y mantener el sistema como un activo operativo vivo en lugar de un proyecto completado.

## **Preguntas frecuentes**

### **¿Cuál es la diferencia entre GPT y RAG?**

**GPT es un tipo de modelo de lenguaje grande que genera respuestas basadas enteramente en patrones aprendidos durante el entrenamiento, mientras que RAG es un enfoque arquitectónico que conecta cualquier modelo de lenguaje, incluido GPT, con fuentes de conocimiento externas que se recuperan e incluyen en el contexto del modelo en el momento de la respuesta.** GPT sin recuperación responde solo desde los datos de entrenamiento, mientras que un sistema RAG basado en GPT recupera información actual relevante antes de generar su respuesta, produciendo respuestas basadas en fuentes específicas y verificables en lugar de generalizaciones de datos de entrenamiento.

### **¿Cuál es la diferencia entre RAG y AI generativa?**

**La AI generativa es la categoría amplia de sistemas de AI que producen contenido nuevo, incluido texto, imágenes y audio, mientras que RAG es una técnica específica aplicada a la AI generadora de texto que aumenta la generación con un paso de recuperación que extrae información relevante de fuentes externas antes de que el modelo genere su respuesta.** Todos los sistemas RAG son AI generativa, pero la mayoría de los sistemas de AI generativa no son sistemas RAG. RAG es una mejora arquitectónica que hace que la AI generativa sea más precisa y actual para tareas intensivas en conocimiento.

### **¿Qué es RAG vs LLM?**

**Un LLM es un modelo de lenguaje que genera texto basado en datos de entrenamiento, mientras que RAG es una arquitectura que empareja un LLM con un sistema de recuperación para que el modelo genere respuestas basadas en documentos recuperados en lugar de solo en datos de entrenamiento.** El LLM en un sistema RAG maneja la comprensión y generación del lenguaje mientras que el componente de recuperación maneja la búsqueda de información actual y específica relevante para cada consulta. Juntos producen resultados que son más precisos, verificables y relevantes para la organización que cualquiera de los componentes produce de forma independiente.

### **¿Qué problemas resuelve RAG?**

**RAG resuelve principalmente tres problemas: la limitación del corte de entrenamiento que hace que los LLM estándar no puedan responder preguntas sobre eventos recientes o información actual, la limitación de alcance que impide que los modelos conozcan el conocimiento organizacional propietario que nunca estuvo en datos de entrenamiento públicos, y el problema de alucinación donde los modelos generan respuestas plausibles pero inexactas cuando carecen del conocimiento específico que una pregunta requiere.** Al recuperar contenido relevante antes de generar respuestas, RAG basa los resultados de AI en fuentes verificables en lugar de patrones estadísticos, produciendo respuestas que pueden verificarse, citarse y confiarse para aplicaciones críticas para el negocio.

### **¿Qué 3 trabajos sobrevivirán a la AI?**

**Las tres categorías de trabajo más resistentes al desplazamiento por AI son los roles que requieren interacción con el mundo físico y destreza en entornos no estructurados, los roles centrados en el juicio humano complejo, el razonamiento ético y la rendición de cuentas por decisiones consecuentes, y los roles construidos en torno a la confianza interpersonal, la inteligencia emocional y la gestión de relaciones.** La AI RAG y sistemas similares están haciendo que la recuperación y síntesis de conocimiento sean altamente automatizables, lo que refuerza el valor de las capacidades distintivamente humanas de las que dependen estos roles en lugar de las tareas de procesamiento de información que la AI ahora maneja de manera más eficiente.
