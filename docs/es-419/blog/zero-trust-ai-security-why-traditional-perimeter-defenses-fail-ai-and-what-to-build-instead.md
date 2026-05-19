---
title: "Seguridad de IA con confianza cero: por qué las defensas perimetrales
  tradicionales fallan con la IA y qué construir en su lugar"
date: 2026-04-04
description: La seguridad de IA con confianza cero aplica verificación continua
  y acceso de mínimo privilegio a los sistemas de IA, tratando a cada modelo,
  usuario y flujo de datos como no confiable por defecto.
author: triggerfish
tags:
  - AI agent
draft: false
---
La seguridad de IA con confianza cero es la aplicación de los principios de zero trust a los sistemas de inteligencia artificial, exigiendo que cada usuario, modelo, fuente de datos y punto de integración sea verificado continuamente y reciba solo el acceso mínimo necesario para cumplir su función, sin que se extienda confianza implícita basada en la ubicación de red o en una autenticación previa. Trata a los sistemas de IA como objetivos de alto valor que requieren los mismos controles de acceso rigurosos que cualquier otra infraestructura privilegiada.

El modelo tradicional de perímetro de seguridad asumía que las amenazas venían desde fuera de la red y que se podía confiar en los sistemas internos. Esa suposición ya estaba bajo presión antes de la llegada de la IA. Los despliegues de IA la rompen por completo. Un sistema de IA conectado a bases de datos internas, correo, repositorios de documentos y APIs externas opera a través de un límite de confianza que un modelo perimetral no puede definir, mucho menos defender. Acepta entradas desde cualquier lugar, recupera contenido de múltiples fuentes y toma acciones a través de sistemas conectados en secuencias que ningún modelo tradicional de control de acceso fue diseñado para gobernar. La superficie de ataque no es un perímetro definido. Es el conjunto completo de conexiones que un sistema de IA puede recorrer, el rango completo de contenidos que procesará y el alcance completo de acciones que está autorizado a realizar. La seguridad de IA con confianza cero aborda esa realidad reemplazando la suposición perimetral con verificación continua en cada interacción, cada acceso a datos y cada acción que realiza el sistema de IA. Esta guía explica cómo los principios de zero trust se aplican específicamente a los despliegues de IA, cómo lucen los siete pilares en un contexto de IA y qué necesitan construir las organizaciones para que el modelo funcione en la práctica.



![AI agent](/blog/images/architectural.jpg)

## **Por qué la seguridad perimetral falla específicamente para los sistemas de IA**

### **El problema de la IA conectada**

Una aplicación empresarial convencional tiene un conjunto definido de usuarios, un conjunto definido de funciones y un conjunto relativamente predecible de patrones de acceso a datos. Los equipos de seguridad pueden construir controles de acceso alrededor de esas definiciones, monitorear desviaciones y tratar las anomalías como señales de posible compromiso. La previsibilidad del comportamiento es lo que hace que la seguridad perimetral sea viable incluso cuando es imperfecta.

Los sistemas de IA, particularmente los sistemas de IA agéntica y los conectados a pipelines de recuperación, no tienen un comportamiento predecible en el mismo sentido. Sus respuestas varían con las entradas. Los datos a los que acceden dependen de las consultas que se generan en tiempo de ejecución en lugar de una lista de acceso predefinida. Las acciones que toman a través de herramientas conectadas dependen de las tareas que reciben en lugar de un conjunto fijo de funciones. La seguridad perimetral construida en torno a una definición estática de lo que hace el sistema no puede mantenerse al día con la realidad dinámica de lo que realmente accede y ejecuta.

Los ataques de prompt injection explotan directamente esta brecha. Un atacante que pueda introducir instrucciones maliciosas en cualquier contenido que un sistema de IA recupere o reciba puede potencialmente redirigir el comportamiento del sistema por completo, haciendo que acceda a datos, ejecute acciones o exponga información de maneras que evaden todos los controles perimetrales que rigen el comportamiento normal del sistema. El ataque no cruza un límite de red. Cruza un límite de confianza dentro del propio procesamiento del sistema, en un canal que las defensas perimetrales no están posicionadas para monitorear.

La seguridad de IA con confianza cero aborda esto moviendo la verificación desde el perímetro de red hacia cada interacción individual. En lugar de preguntar si un usuario o sistema está dentro de la red confiable, pregunta si esta solicitud específica, desde esta identidad específica, para este recurso específico, en este momento específico, está autorizada. Esa pregunta se hace continuamente, no una sola vez en la autenticación.

### **Cómo la IA amplifica las consecuencias de las violaciones de confianza**

La razón por la que la seguridad de IA con confianza cero importa más que el zero trust para aplicaciones convencionales no es que los sistemas de IA sean inherentemente menos seguros. Es que las consecuencias de una violación de confianza en un sistema de IA conectado se amplifican por la conectividad y autonomía del sistema de maneras que las violaciones equivalentes en sistemas convencionales no lo hacen.

Una cuenta de usuario comprometida en una aplicación convencional crea acceso a lo que ese usuario pueda acceder. Un agente de IA comprometido o manipulado con amplio acceso a herramientas puede potencialmente recorrer múltiples sistemas conectados, extraer datos de varias fuentes y tomar acciones a través de múltiples plataformas en una única secuencia automatizada que requeriría un esfuerzo significativo del atacante para replicarse manualmente. La automatización que hace valiosos a los agentes de IA en tareas legítimas también los hace eficientes en tareas ilegítimas cuando su comportamiento es manipulado o su acceso es explotado.

La seguridad de IA con confianza cero reduce el radio de impacto de las violaciones de confianza al garantizar que incluso un sistema de IA manipulado con éxito solo pueda acceder y afectar los recursos específicos para los que ha recibido permiso en el contexto actual, en lugar de heredar un acceso amplio que fue otorgado en la autenticación y nunca revisado.

Revisar cómo las decisiones de arquitectura de[ seguridad de IA](https://trigger.fish/security/) en torno al alcance de acceso y la verificación continua afectan el radio de impacto práctico del compromiso del sistema de IA ayuda a las organizaciones a construir despliegues donde las consecuencias de las fallas de seguridad están acotadas en lugar de no acotadas.



![AI agent](/blog/images/enterprise-security.jpg)

## **Los siete pilares de zero trust aplicados a los sistemas de IA**

La seguridad zero trust está organizada en torno a siete pilares que en conjunto definen la arquitectura completa de verificación y control. Cada pilar adquiere características y requisitos específicos cuando se aplica a sistemas de IA en lugar de aplicaciones convencionales.

### **Pilar uno: verificación de identidad**

En el zero trust convencional, la verificación de identidad cubre usuarios humanos y cuentas de servicio. En la seguridad de IA con confianza cero, la superficie de identidad se expande para incluir al propio modelo de IA como una identidad que necesita ser verificada, a los agentes que actúan en nombre de los usuarios que deben distinguirse de esos usuarios para fines de control de acceso, y a las cuentas de servicio que los sistemas de IA usan para acceder a recursos conectados, que necesitan administrarse con el mismo rigor que las cuentas privilegiadas humanas.

La autenticación continua en lugar de la autenticación basada en sesión es el estándar zero trust para usuarios humanos que acceden a sistemas de IA. La autenticación multifactor, la analítica de comportamiento que monitorea patrones de uso anómalos y las políticas de acceso conscientes del contexto que ajustan los requisitos de verificación según la sensibilidad de lo que se solicita, todas se aplican en los despliegues de sistemas de IA.

Para los agentes de IA que operan de manera autónoma, el desafío de identidad es mantener el principio de que el acceso del agente esté limitado a la tarea específica que está realizando en lugar de heredar el acceso completo del usuario humano que lo inició. Un agente que ejecuta una tarea de investigación en nombre de un usuario debería tener acceso de investigación, no la huella completa de acceso del usuario. Ese alcance requiere una arquitectura de identidad explícita en lugar de la herencia predeterminada que implementan muchos marcos de agentes.

### **Pilar dos: seguridad de dispositivos**

La seguridad de dispositivos en un contexto de IA zero trust cubre tanto los puntos finales desde los cuales los usuarios acceden a los sistemas de IA como la infraestructura en la que se ejecutan los modelos de IA. Para los dispositivos de usuario, se aplican los controles estándar de zero trust: verificación de salud del dispositivo antes de otorgar acceso, cobertura de detección y respuesta de endpoints, y políticas de acceso que varían según el estado de gestión del dispositivo.

La capa de infraestructura requiere atención específica porque el hardware de inferencia de IA representa un objetivo de alto valor para el cual la seguridad tradicional de endpoints no fue diseñada. Los servidores GPU que ejecutan grandes modelos contienen tanto los pesos del modelo, que representan propiedad intelectual significativa, como los datos que se procesan a través de la inferencia, que pueden incluir información organizacional sensible. La seguridad física y lógica de la infraestructura de inferencia de IA merece la misma gestión de acceso privilegiado, monitoreo de integridad y registro de acceso que otros activos de infraestructura de alto valor.

### **Pilar tres: segmentación de red**

La arquitectura de red zero trust reemplaza la red plana confiable con zonas microsegmentadas donde el tráfico entre segmentos requiere autorización explícita en lugar de fluir libremente dentro del perímetro. Para los sistemas de IA, la segmentación de red determina qué componentes de la arquitectura de IA pueden comunicarse con cuáles otros y a qué recursos externos puede acceder el sistema de IA.

Los servidores de inferencia de IA deben estar segmentados en red de los recursos a los que no necesitan acceder. Un modelo que atiende consultas de servicio al cliente no necesita acceso de red a sistemas financieros. Una herramienta de IA de investigación no necesita acceso a bases de datos de RR. HH. La arquitectura de red debe hacer cumplir estas separaciones en lugar de confiar en que el comportamiento del sistema de IA las respete voluntariamente, porque la inyección de prompts y otras técnicas de manipulación pueden potencialmente anular las restricciones de comportamiento, mientras que la segmentación de red las hace cumplir físicamente.

El acceso de red externo para los sistemas de IA, incluido el acceso a búsqueda web, APIs externas y servicios en la nube, debe permitirse explícitamente a través de listas de permitidos en lugar de permitirse por defecto con excepciones bloqueadas. El valor por defecto para la conectividad externa del sistema de IA en una arquitectura zero trust es sin acceso, con destinos específicos permitidos agregados según requisitos operativos documentados.

### **Pilar cuatro: seguridad de aplicaciones**

La seguridad de aplicaciones en el contexto de IA zero trust cubre la seguridad de la capa de aplicación de IA en sí, incluida la infraestructura de prompting, los pipelines de recuperación, las integraciones de herramientas y la lógica de manejo de salidas que en conjunto definen cómo el sistema de IA procesa las solicitudes y produce respuestas.

La validación y sanitización de entradas en la capa de aplicación representa el principio zero trust de verificar el contenido, no solo la identidad, aplicado a los sistemas de IA. Cada entrada que llega al modelo, ya sea de usuarios, documentos recuperados, salidas de herramientas o mensajes del sistema, debe tratarse como potencialmente adversaria y procesarse a través de filtros apropiados en lugar de confiarse implícitamente.

La validación de salidas aplica el mismo principio a la inversa. Cada salida que el sistema de IA produce antes de llegar a los usuarios, sistemas conectados o procesos posteriores debe inspeccionarse contra criterios definidos que detecten contenido dañino, fuga de datos sensibles y anomalías de comportamiento que sugieran que el modelo ha sido manipulado.

Entender cómo las decisiones de[ arquitectura de IA](https://trigger.fish/architecture/) en la capa de aplicación afectan la implementación práctica de los controles zero trust de entrada y salida ayuda a las organizaciones a construir sistemas de IA donde la seguridad está integrada en el pipeline de procesamiento en lugar de añadirse al perímetro.



![AI agent](/blog/images/layered-security.jpg)

### **Pilar cinco: seguridad de datos**

La seguridad de datos bajo zero trust en IA requiere tratar cada acceso a datos por parte de un sistema de IA como una operación que requiere autorización explícita en lugar de heredar permisos amplios. Este pilar es donde los despliegues de IA requieren más directamente controles zero trust diseñados a propósito porque las arquitecturas existentes de seguridad de datos no fueron diseñadas para los patrones dinámicos de acceso a datos impulsados por consultas que crean los sistemas de recuperación de IA.

La clasificación de datos que los sistemas de IA respetan en su comportamiento de recuperación y procesamiento requiere integración entre la infraestructura de gobernanza de datos y la capa de control de acceso de IA. Cuando el nivel de autorización de un usuario determina a qué documentos puede acceder directamente en un sistema de gestión de documentos, el sistema de IA que recupera documentos en nombre de ese usuario debería respetar el mismo límite de autorización, devolviendo solo los documentos que el usuario está autorizado a ver en lugar de todo lo de la base de conocimientos que es relevante para su consulta.

La minimización de datos, un principio central de datos en zero trust, requiere que los sistemas de IA accedan y procesen solo los datos específicos necesarios para la tarea actual. A un asistente de IA al que se le pide redactar una respuesta de correo electrónico no necesita acceso al historial completo del cliente. Una herramienta de IA que resume un documento específico no necesita acceso a la carpeta circundante. Implementar la minimización de datos en los sistemas de IA requiere controles de acceso que operen a nivel granular de datos en lugar de a nivel de sistema o base de datos.

Revisar cómo las[ funcionalidades de IA](https://trigger.fish/features/) en las plataformas empresariales de IA implementan controles de acceso a datos y autorización de recuperación ayuda a las organizaciones a evaluar si la arquitectura de seguridad de datos de un proveedor admite principios zero trust o requiere controles complementarios para lograr el mismo efecto.

### **Pilar seis: visibilidad y analítica**

La seguridad zero trust se basa en la capacidad de detectar anomalías que indican violaciones de confianza, lo que requiere una visibilidad integral de todo lo que hace el sistema de IA. Sin cobertura de registro y monitoreo en cada interacción del sistema de IA, la verificación zero trust no produce señal cuando ocurren violaciones porque no existe la evidencia requerida para detectarlas.

Para los sistemas de IA, los requisitos de visibilidad van más allá del registro convencional de aplicaciones. Cada consulta enviada al modelo, cada documento recuperado a través de pipelines RAG, cada llamada a herramienta ejecutada por un agente, cada salida producida por el sistema y cada decisión de control de acceso tomada en cada punto de verificación deben capturarse en registros que los equipos de operaciones de seguridad puedan monitorear e investigar.

La analítica de comportamiento aplicada a los registros de actividad del sistema de IA crea la capacidad de detección de anomalías que hace que la visibilidad zero trust sea accionable. Los modelos de línea base del comportamiento normal del sistema de IA, incluidos los patrones típicos de consulta, los volúmenes habituales de recuperación y las frecuencias estándar de uso de herramientas, permiten la detección de desviaciones que pueden indicar inyección de prompts, intentos de exfiltración de datos o patrones de acceso no autorizados que serían invisibles sin puntos de referencia de comportamiento.

### **Pilar siete: automatización y orquestación**

El zero trust a escala empresarial no se puede operar manualmente. Las decisiones de verificación, las respuestas a anomalías y las actualizaciones de políticas de acceso que requiere la verificación continua ocurren con una frecuencia y a través de una complejidad de sistema que la operación humana no puede igualar. La automatización y orquestación, el pilar final de zero trust, cubre los sistemas que hacen que zero trust sea operativo a escala en lugar de teórico en documentos de arquitectura.

Para los sistemas de IA específicamente, la respuesta automatizada a anomalías detectadas, incluida la limitación de tasa activada por patrones de consulta inusuales, la restricción de acceso activada por anomalías de comportamiento y la escalada de alertas activada por firmas potenciales de inyección de prompts, proporciona la velocidad de respuesta que hace que la detección zero trust sea significativa. La detección sin respuesta automatizada crea un sistema que identifica amenazas más rápido de lo que los humanos pueden actuar sobre ellas.


<table>
  <thead>
    <tr>
      <th>Pilar Zero Trust</th>
      <th>Aplicación convencional</th>
      <th>Extensión específica para sistemas de IA</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Identidad</td>
      <td>Verificación de usuario y cuenta de servicio</td>
      <td>Más identidad de agente de IA, credenciales de tarea con alcance</td>
    </tr>
    <tr>
      <td>Dispositivo</td>
      <td>Salud del endpoint y estado de gestión</td>
      <td>Más integridad de infraestructura de inferencia de IA</td>
    </tr>
    <tr>
      <td>Red</td>
      <td>Microsegmentación entre zonas</td>
      <td>Más listas de permitidos específicas de IA para acceso externo</td>
    </tr>
    <tr>
      <td>Aplicación</td>
      <td>Validación de entrada y monitoreo de salida</td>
      <td>Más detección de inyección de prompts, filtrado de salida</td>
    </tr>
    <tr>
      <td>Datos</td>
      <td>Control de acceso basado en clasificación</td>
      <td>Más autorización de recuperación, minimización de datos en consultas</td>
    </tr>
    <tr>
      <td>Visibilidad</td>
      <td>Registros de aplicación y acceso</td>
      <td>Más registros de consulta al modelo, recuperación, llamada a herramienta y salida</td>
    </tr>
    <tr>
      <td>Automatización</td>
      <td>Aplicación de políticas y respuesta a anomalías</td>
      <td>Más analítica de comportamiento y respuesta específicas de IA</td>
    </tr>
  </tbody>
</table>



## **Construir seguridad de IA con confianza cero en la práctica**

### **Comenzar con una auditoría de acceso**

El punto de partida práctico para la seguridad de IA con confianza cero es una auditoría honesta de a qué puede acceder actualmente cada sistema de IA en el despliegue de la organización frente a a qué necesita realmente acceder para su función definida. La brecha entre esos dos inventarios define el trabajo de remediación de mínimo privilegio que acerca el despliegue a los principios zero trust.

La mayoría de los sistemas de IA, particularmente aquellos que han evolucionado a través de trabajo de integración iterativa, han acumulado permisos de acceso que reflejan la historia de lo que se conectó en lugar de una evaluación deliberada de lo que es necesario. Una herramienta de IA de investigación que se integró con el correo electrónico para recuperar documentos referenciados, luego se conectó al sistema de gestión de documentos para un contexto más amplio, luego se vinculó al CRM para referencia de clientes, puede ahora tener acceso a tres sistemas que cada uno contiene datos sensibles mucho más allá de lo que cualquier tarea específica de investigación requiere.

La auditoría de acceso produce un mapa de capacidades, cada sistema al que una herramienta de IA puede acceder, cada acción que puede tomar y cada categoría de datos que puede recuperar, junto con un mapa de requisitos operativos, cada sistema que realmente necesita para su función definida, cada acción que esa función legítimamente requiere y cada categoría de datos que la función genuinamente necesita. La remediación es cerrar la brecha entre los dos a través de la reducción del alcance de acceso, la segmentación de red y el despliegue de patrones de acceso just-in-time para capacidades que el sistema necesita ocasionalmente en lugar de continuamente.

### **Implementar verificación continua sin degradar el rendimiento**

Una preocupación común sobre la aplicación de los principios zero trust a los sistemas de IA es que la verificación continua introducirá latencia que degradará la experiencia del usuario de herramientas de IA que necesitan responder rápidamente. Esta preocupación es real pero manejable a través de elecciones de arquitectura que ubican la verificación en los puntos correctos en lugar de añadirla uniformemente a cada interacción.

La verificación a nivel de sesión para el acceso de usuario autenticado maneja la mayoría de la sobrecarga de verificación de identidad humana con un solo evento de autenticación en lugar de por consulta. Las decisiones de autorización en caché para patrones de acceso a datos que se repiten con frecuencia reducen la sobrecarga de verificación para las operaciones de recuperación sin abandonar el requisito de verificación. La verificación asincrónica para operaciones de menor sensibilidad que pueden tolerar una resolución de autorización ligeramente retrasada preserva el rastro de auditoría zero trust sin latencia sincrónica en cada interacción.

Los puntos de verificación que genuinamente requieren un comportamiento de bloqueo sincrónico antes de proceder son aquellos que rigen el acceso a datos de alta sensibilidad, las acciones con consecuencias significativas o irreversibles y las anomalías de comportamiento que activan un escrutinio elevado. Para las operaciones rutinarias dentro de líneas base de comportamiento establecidas, la verificación puede manejarse eficientemente sin latencia visible para el usuario a través de arquitecturas de caché y asincrónicas bien diseñadas.

Una completa[ guía de IA](https://trigger.fish/guide/) sobre la implementación de arquitecturas de seguridad de IA con confianza cero que equilibran el rigor de verificación con el rendimiento operativo ayuda a las organizaciones a evitar la falsa elección entre seguridad y usabilidad que crean las implementaciones mal diseñadas.

**SUGERENCIA DE IMAGEN: Un desarrollador o arquitecto de seguridad en una estación de trabajo de doble monitor revisando configuraciones de control de acceso para un despliegue de sistema de IA, entorno técnico organizado, código o configuración visible en una pantalla y un diagrama del sistema en la otra, sin texto legible visible en ninguna pantalla.**

## **Cosas que deben saber**

Varias realidades importantes sobre la seguridad de IA con confianza cero que las organizaciones encuentran al pasar de los principios de arquitectura a la implementación operativa:

Zero trust es un proceso continuo, no un estado de despliegue. Las organizaciones no logran zero trust y lo mantienen de manera pasiva. Se mueven continuamente hacia zero trust a través de la reducción continua del alcance de acceso, la expansión de la cobertura de monitoreo y la mejora de la arquitectura de verificación. La meta es direccional y continua en lugar de un estado de finalización definido.

Las integraciones de IA heredadas son el objetivo de remediación zero trust más difícil. Los sistemas de IA que se integraron con la infraestructura existente antes de que se aplicaran los principios zero trust al despliegue a menudo tienen patrones de acceso que son técnicamente difíciles de delimitar sin romper la funcionalidad. Remediar estas integraciones requiere comprender tanto el requisito zero trust como la dependencia operativa, lo que a menudo significa trabajar a través de las integraciones una por una en lugar de aplicar un cambio uniforme de política.

El principio del 30 % se aplica a la automatización de verificación zero trust. Los controles de verificación automatizados deben manejar aproximadamente el 30 % de las operaciones de seguridad, específicamente las decisiones de acceso basadas en políticas de alta frecuencia y el monitoreo de comportamiento que la automatización ejecuta de manera consistente a escala. Los profesionales de seguridad y los responsables de gobernanza manejan el 70 % restante que involucra evaluación de riesgos, diseño de políticas, investigación de anomalías y las decisiones de seguridad intensivas en juicio que requieren responsabilidad humana en lugar de ejecución algorítmica.

Zero trust no elimina la necesidad de seguridad perimetral. Se superpone con los controles perimetrales en lugar de reemplazarlos. Las organizaciones que se mueven hacia la seguridad de IA con confianza cero mantienen los controles perimetrales de red mientras añaden las capas de verificación de identidad, datos y comportamiento que proporciona zero trust. El perímetro se convierte en una capa entre muchas en lugar de la defensa principal.

Los impactos en la experiencia del usuario de la implementación zero trust determinan el éxito de la adopción. Las arquitecturas de seguridad que hacen que las herramientas de IA sean significativamente más engorrosas de usar empujan a los empleados hacia alternativas de IA en la sombra que operan fuera de cualquier control zero trust. Diseñar flujos de verificación que sean mínimamente intrusivos para el uso legítimo mientras se mantienen controles rigurosos para operaciones anómalas o de alto riesgo es un requisito de calidad de implementación, no una mejora opcional.

El soporte zero trust de los proveedores varía significativamente entre las plataformas de IA empresariales. Algunas herramientas de IA empresariales están diseñadas con puntos de integración zero trust que incluyen federación de identidad, controles de acceso granulares, APIs integrales de registro y soporte de monitoreo de comportamiento. Otras requieren una infraestructura suplementaria significativa para lograr una cobertura zero trust equivalente. Evaluar el soporte zero trust del proveedor como parte de la selección de herramientas de IA reduce la carga de implementación en relación con la adaptación de controles zero trust a herramientas que no fueron diseñadas para ellos.

La responsabilidad conjunta entre los equipos de seguridad y operaciones de IA es esencial para que los programas de seguridad de IA con confianza cero funcionen en la práctica. Los equipos de seguridad aportan la experiencia zero trust. Los equipos de operaciones de IA aportan la comprensión del comportamiento del sistema de IA, las dependencias de integración y los requisitos operativos que determinan dónde los controles de verificación son prácticos y dónde requieren soluciones arquitectónicas. Los programas diseñados por equipos de seguridad sin aportes de operaciones de IA tienden a crear arquitecturas de seguridad teóricas que fallan en el despliegue.

## **Zero trust como la base correcta para un despliegue de IA con confianza**

La seguridad de IA con confianza cero no es la arquitectura de seguridad más conveniente para los sistemas de IA. Requiere un diseño de acceso más deliberado, más inversión en infraestructura de verificación y más disciplina operativa que la seguridad perimetral o los modelos de confianza implícita. Las organizaciones que hacen esa inversión consistentemente encuentran que habilita en lugar de restringir sus ambiciones de IA porque crea la base de seguridad que permite que los sistemas de IA se conecten más ampliamente, se confíen más profundamente y se desplieguen en contextos de mayor riesgo que los sistemas que operan sin un rigor de verificación equivalente.

Los sistemas de IA que en última instancia llevarán el mayor valor organizacional son aquellos a los que se les confían los datos más sensibles, se conectan a los sistemas más consecuentes y se les autoriza a tomar las acciones de mayor impacto. La seguridad de IA con confianza cero es la arquitectura que hace que esa confianza sea defendible en lugar de aspiracional, proporcionando la verificación continua, la visibilidad de comportamiento y el alcance de acceso que permiten a las organizaciones extender una confianza significativa a los sistemas de IA en lugar de aceptar la exposición como el costo de la capacidad.

## **Preguntas frecuentes**

### **¿Qué es Zero Trust en IA?**

**Zero trust en IA es la aplicación de los principios de verificación continua y acceso de mínimo privilegio a los sistemas de inteligencia artificial, exigiendo que cada usuario, modelo, agente, acceso a datos e interacción con herramientas sea verificado contra la autorización actual en lugar de depender de la confianza implícita otorgada en la autenticación inicial o basada en la ubicación de red.** Trata los sistemas de IA como objetivos de alto valor con comportamiento dinámico y conectado que requiere una arquitectura de verificación específicamente diseñada para cómo operan realmente los sistemas de IA, en lugar de los modelos convencionales de seguridad de aplicaciones que no consideran las superficies de ataque específicas de IA.

### **¿Qué es la seguridad zero trust?**

**La seguridad zero trust es un modelo de seguridad basado en el principio de que ningún usuario, dispositivo o sistema debe ser confiado implícitamente según su ubicación de red, exigiendo en su lugar que cada solicitud de acceso sea verificada continuamente contra la identidad, la salud del dispositivo y las políticas de autorización contextual antes de que se otorgue acceso.** Reemplaza el modelo perimetral tradicional que confiaba en todo lo que estaba dentro del límite de la red con un modelo que trata cada interacción como potencialmente no confiable y requiere verificación en cada punto de acceso independientemente de dónde se origine la solicitud.

### **¿Cuál es un ejemplo de modelo de seguridad zero trust?**

**Un ejemplo práctico de un modelo de seguridad zero trust en un despliegue de IA es un asistente de IA empresarial donde cada usuario se autentica con autenticación multifactor antes de acceder al sistema, el pipeline de recuperación de la IA aplica los permisos de documentos del usuario solicitante para que solo pueda exponer contenido que esté autorizado a ver, todas las llamadas a herramientas que hace el agente de IA requieren autorización explícita por acción en lugar de heredar permisos amplios de cuenta de servicio, y cada consulta, recuperación y acción se registra para el monitoreo de comportamiento que marca anomalías para revisión de seguridad.** Este ejemplo ilustra zero trust aplicado a través de las dimensiones de identidad, datos y acciones de un sistema de IA en lugar de solo en el perímetro de red.

### **¿Cómo mejora la seguridad Zero Trust?**

**Zero trust mejora la seguridad reduciendo el radio de impacto de los ataques exitosos a través del alcance de acceso de mínimo privilegio que limita lo que una identidad comprometida o un sistema de IA manipulado puede acceder, permitiendo una detección de anomalías más rápida a través del registro integral de todos los eventos de acceso contra líneas base de comportamiento, y eliminando las suposiciones de confianza implícita que los atacantes explotan a través del movimiento lateral una vez que están dentro de un perímetro de red.** Para los sistemas de IA específicamente, zero trust mejora la seguridad aplicando verificación continua al comportamiento dinámico y conectado de los agentes de IA que las defensas perimetrales no pueden gobernar porque no tienen un límite definido para proteger.

### **¿Cuáles son los 7 pilares de Zero Trust?**

**Los siete pilares de zero trust son: verificación de identidad que requiere autenticación continua de usuarios y sistemas, seguridad de dispositivos que garantiza la salud del endpoint antes de otorgar acceso, segmentación de red que reemplaza la red plana confiable con zonas microsegmentadas que requieren autorización explícita entre ellas, seguridad de aplicaciones que aplica validación de entrada y monitoreo de salida en la capa de aplicación, seguridad de datos que aplica controles de acceso basados en clasificación y minimización de datos, visibilidad y analítica que proporciona registro integral y detección de anomalías de comportamiento, y automatización y orquestación que permite la aplicación de políticas y la respuesta a anomalías a la escala y velocidad que requiere la verificación continua.** Aplicados a los sistemas de IA, cada pilar adquiere extensiones específicas que abordan las características únicas del comportamiento, la conectividad y la superficie de ataque de IA que la seguridad de aplicaciones convencional no fue diseñada para gobernar.
