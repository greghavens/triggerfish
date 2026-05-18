---
title: "  IA con air gap: qué es, por qué importa y quién la necesita realmente"
date: 2026-03-06
description: La IA con air gap se ejecuta en sistemas aislados sin conexión a
  internet, ofreciendo a las organizaciones la máxima seguridad de datos y
  control total sobre las cargas de trabajo de IA sensibles.
author: triggerfish
tags:
  - AI agent
draft: false
---


La IA con air gap hace referencia a los sistemas de inteligencia artificial desplegados en hardware aislado física y lógicamente de internet y de cualquier red externa. Es el nivel más alto de seguridad de datos disponible para el despliegue de IA, utilizado cuando las consecuencias de una brecha son sencillamente demasiado altas para aceptar cualquier conectividad externa.

La mayoría de las empresas que exploran el despliegue de IA privada están pensando en configuraciones on-premise o configuraciones de nube privada. Esas son opciones sólidas para la mayoría de los casos de uso. Pero existe una categoría de organizaciones para las cuales incluso un servidor privado fuertemente protegido con acceso VPN no es suficiente. Las agencias gubernamentales que manejan inteligencia clasificada, los contratistas de defensa que procesan datos de sistemas de armamento, los operadores de infraestructura crítica y las instituciones de investigación que trabajan en descubrimientos sensibles operan todas en entornos donde el aislamiento de red no es una preferencia sino un requisito. Esta guía explica cómo se ve la IA con air gap en la práctica, cómo se despliega, qué cuesta operativamente y si vuestra organización realmente la necesita o solo cree que la necesita.



![AI agent](/blog/images/secured-server.jpg)

## **Qué significa realmente "air gapped"**

El término proviene de la brecha física de aire entre un sistema aislado y cualquier red conectada. No hay cable ethernet conectado a internet. No hay adaptador WiFi habilitado. No hay Bluetooth. Los datos entran y salen únicamente a través de medios físicos, es decir, unidades USB, discos ópticos o estaciones de transferencia de archivos con air gap que a su vez no tienen conectividad externa.

Esto es fundamentalmente diferente de un cortafuegos, una VPN o incluso un despliegue en nube privada. Todos esos siguen implicando que los datos viajen a través de redes, incluso si esas redes están cifradas y con control de acceso. Un sistema con air gap no transmite datos a través de ninguna red en absoluto. El aislamiento es físico, no solo lógico.

En el contexto de la IA, esto significa que el modelo, el motor de inferencia, los datos de entrenamiento y cualquier salida generada por el sistema viven en hardware que nunca ha tocado internet público tras su despliegue. Las actualizaciones del modelo requieren transferencias de medios físicos. Los nuevos datos de entrenamiento se mueven de la misma manera. Las salidas se revisan y extraen mediante procesos físicos controlados.

Suena extremo porque para la mayoría de las organizaciones lo es. Pero para los entornos donde aplica, es la única arquitectura que satisface el modelo de amenazas real bajo el cual están operando.

## **Quién necesita IA con air gap y por qué**



![AI agent](/blog/images/analyst.jpg)

### **Aplicaciones de defensa e inteligencia**

Las agencias militares y de inteligencia fueron los arquitectos originales de los protocolos de air gap, mucho antes de que la IA entrara en escena. Los sistemas clasificados han operado en aislamiento total de red durante décadas porque las consecuencias de una brecha en esos entornos se miden en vidas y resultados de seguridad nacional, no en costes de notificación de violación de datos.

Llevar la IA a esos entornos no cambia el requisito de aislamiento. Añade capacidad a una infraestructura que ya exige separación física. Las agencias que usan IA para análisis de inteligencia de señales, reconocimiento de patrones de amenazas u optimización logística necesitan modelos que se ejecuten enteramente dentro de redes clasificadas que nunca han estado conectadas al mundo exterior.

### **Operadores de infraestructuras críticas**

Las redes eléctricas, las plantas de tratamiento de aguas, las plantas nucleares y los sistemas de compensación financiera caen en una categoría donde la disrupción tiene efectos sociales en cascada. Los sistemas de control industrial que gestionan estos entornos han incorporado cada vez más IA para la detección de anomalías y el mantenimiento predictivo. Ejecutar esos componentes de IA en redes con air gap garantiza que un sistema externo comprometido no pueda alcanzar la tecnología operativa que gestiona la infraestructura física.

### **Entornos sanitarios y legales con requisitos extremos de privacidad**

No todos los casos de uso de air gap implican secretos de Estado. Los hospitales que procesan datos de investigación altamente sensibles, los laboratorios forenses que manejan pruebas y los bufetes de abogados que gestionan asuntos donde incluso la existencia del caso es confidencial requieren a veces aislamiento total de red para cargas de trabajo de IA específicas. El modelo de amenazas aquí tiene menos que ver con actores estatales y más con la protección férrea del privilegio profesional y el cumplimiento normativo con tolerancia cero a la divulgación accidental.

Comprender cómo se diseña la arquitectura de[ AI security](https://trigger.fish/security/) para estos entornos ayuda a las organizaciones a evaluar si su modelo de amenazas real requiere un verdadero air gapping o si un despliegue privado bien protegido sería suficiente.

## **Cómo funcionan en la práctica los despliegues de IA con air gap**

### **Llevar modelos a un entorno aislado**

El proceso de poner en marcha un sistema de IA con air gap comienza antes de que se monte ningún hardware. Los pesos del modelo, que son los ficheros grandes que definen cómo se comporta la IA, deben descargarse, verificarse y transferirse al entorno aislado a través de canales de medios físicos aprobados.

En un despliegue seguro típico, esto significa descargar el modelo en una máquina de staging separada y controlada, ejecutar la verificación de integridad para confirmar que los ficheros no han sido alterados, transferirlos a medios físicos saneados y llevar físicamente esos medios al entorno aislado donde se cargan en el hardware con air gap.

Cualquier actualización del modelo pasa por el mismo proceso. No hay mecanismo de actualización automática. Cada cambio es deliberado, documentado y ejecutado físicamente.


<table>
  <thead>
    <tr>
      <th>Etapa de transferencia</th>
      <th>Proceso</th>
      <th>Control de seguridad</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Descarga del modelo</td>
      <td>Obtenido en máquina de staging conectada a internet</td>
      <td>Verificación de hash contra checksums conocidos</td>
    </tr>
    <tr>
      <td>Preparación de medios</td>
      <td>Escrito en dispositivo de transferencia física saneado</td>
      <td>Medios de escritura única o unidades saneadas</td>
    </tr>
    <tr>
      <td>Transferencia física</td>
      <td>Llevado al perímetro seguro</td>
      <td>Documentación de cadena de custodia</td>
    </tr>
    <tr>
      <td>Instalación</td>
      <td>Cargado en hardware con air gap</td>
      <td>Verificación de integridad repetida en el lado seguro</td>
    </tr>
    <tr>
      <td>Extracción de resultados</td>
      <td>Resultados extraídos mediante proceso inverso</td>
      <td>Revisión de contenido antes de la extracción</td>
    </tr>
  </tbody>
</table>



### **Ejecutar inferencia en hardware aislado**

Una vez instalado el modelo, la operación diaria se ve similar a cualquier otro despliegue de IA on-premise desde la perspectiva del usuario. Los analistas o aplicaciones envían consultas, el modelo las procesa y las respuestas regresan. La diferencia está enteramente en lo que sucede bajo la superficie. No hay telemetría saliendo. No hay llamadas a la API de servicios externos. El sistema es autónomo.

Esto crea algunas restricciones operativas que vale la pena entender. La generación aumentada por recuperación, que permite a los sistemas de IA extraer información fresca de bases de datos conectadas, requiere que esas bases de datos también vivan dentro del entorno con air gap. La información en tiempo real solo es tan actual como la última transferencia física de datos al sistema. Para la mayoría de los casos de uso de air gap, esa es una contrapartida aceptable dados los beneficios de seguridad.

Las decisiones de[ AI architecture](https://trigger.fish/architecture/) tomadas tempranamente en un despliegue con air gap son difíciles de cambiar después, lo que hace que acertar con el diseño inicial sea considerablemente más importante que en una configuración estándar en nube u on-premise.



![Ai agent](/blog/images/usb.jpg)

### **Consideraciones de hardware**

Los sistemas de IA con air gap no pueden depender del escalado de hardware basado en nube. Cualquier capacidad de cómputo que aprovisionéis al inicio es lo que tenéis. Eso hace que la planificación precisa de capacidad sea crítica.


<table>
  <thead>
    <tr>
      <th>Tipo de organización</th>
      <th>Tamaño de modelo típico</th>
      <th>Enfoque de hardware</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Equipo seguro pequeño, consultas limitadas</td>
      <td>7B a 13B parámetros</td>
      <td>Una sola estación de trabajo de alta gama con GPU</td>
    </tr>
    <tr>
      <td>Departamento seguro de tamaño medio</td>
      <td>13B a 34B parámetros</td>
      <td>Servidor dedicado con múltiples GPU</td>
    </tr>
    <tr>
      <td>Escala de agencia o empresa</td>
      <td>34B a 70B parámetros</td>
      <td>Clúster de GPU multinodo, in situ</td>
    </tr>
    <tr>
      <td>Investigación con necesidades multimodales</td>
      <td>Modelos grandes especializados</td>
      <td>Adquisición de hardware personalizado requerida</td>
    </tr>
  </tbody>
</table>



La planificación de redundancia importa más aquí que en entornos conectados. Cuando el hardware falla en una configuración de nube, la capacidad cambia automáticamente. En un entorno con air gap, una avería de hardware significa capacidad reducida hasta que se obtenga, sanee e instale un reemplazo físico. Incorporar redundancia en la especificación inicial de hardware no es opcional en entornos de producción.

## **La realidad operativa de ejecutar IA con air gap**

### **Cómo es realmente el día a día**

Las organizaciones que ejecutan sistemas con air gap desarrollan ritmos operativos disciplinados en torno a las restricciones. Las actualizaciones del modelo ocurren en un ciclo programado en lugar de bajo demanda. Las importaciones de datos siguen procedimientos documentados con múltiples aprobaciones. Las extracciones de salidas se revisan antes de que algo abandone el perímetro seguro.

Esta deliberación es en realidad una característica en ciertos contextos. Cada cambio en el entorno de IA se rastrea, documenta y es auditable. En industrias reguladas, ese rastro de auditoría tiene un valor real. En entornos clasificados, es obligatorio.

El reto es que también ralentiza las cosas en comparación con lo que los equipos acostumbrados a herramientas de IA en la nube podrían esperar. La iteración de prompts que toma segundos en una plataforma en la nube podría tardar días en un entorno con air gap si requiere importar datos nuevos o aplicar una actualización del modelo a través del proceso de transferencia física.

Un punto de referencia útil es el enfoque cubierto en los recursos de[ AI guide](https://trigger.fish/guide/) sobre despliegue por fases, que se aplica directamente aquí. Empezar con un caso de uso estrecho y bien definido antes de expandir el alcance del sistema con air gap evita que la expansión del alcance cree problemas operativos antes de que el equipo haya desarrollado el músculo procedimental para gestionar el entorno.

### **Requisitos de personal y experiencia**

Ejecutar un sistema de IA con air gap requiere personas que entiendan tanto el stack de IA como los protocolos de seguridad que rigen el entorno aislado. Esa combinación es genuinamente rara y exige una compensación significativa. Los roles especializados involucrados en la gestión de entornos de IA clasificados o con air gap se encuentran entre las posiciones mejor pagadas en el sector tecnológico, reflejando la escasez de personas que poseen las acreditaciones necesarias junto con habilidades prácticas de ingeniería de IA.

Las organizaciones que ponen en marcha estos sistemas por primera vez típicamente subestiman la complejidad del personal. Planificad personal dedicado que sea responsable del ciclo de vida de la gestión del modelo, no solo generalistas de TI que lo manejen como responsabilidad secundaria.

## **Air gap vs. otros enfoques de despliegue privado**

La decisión entre un air gap completo y un despliegue privado bien protegido no siempre es obvia. Aquí hay una forma práctica de razonarlo.

Si vuestra preocupación principal es la privacidad de datos y el cumplimiento, un despliegue on-premise configurado adecuadamente con controles de acceso fuertes y sin exposición a internet público típicamente satisface el requisito sin la sobrecarga operativa del verdadero air gapping.

Si vuestra preocupación implica actores de amenaza con capacidades sofisticadas, incluidos ataques a nivel de Estado-nación, amenazas internas o cualquier escenario donde incluso el tráfico de red cifrado represente un riesgo inaceptable, entonces el air gapping aborda el modelo de amenazas que otros enfoques no pueden.

La evaluación honesta para la mayoría de las empresas es que el verdadero air gapping es más de lo que necesitan. Las empresas que realmente lo necesitan tienden a saber que lo necesitan antes de empezar a investigar opciones. Los requisitos regulatorios, contractuales o de contexto de misión suelen tomar la decisión por ellas.

## **Cosas que conviene saber**

Algunos detalles que tienden a pasarse por alto en las conversaciones tempranas sobre despliegues de IA con air gap:

La seguridad física importa tanto como la seguridad digital. Un sistema con air gap es solo tan seguro como la sala en la que está. Los controles de acceso físico, la vigilancia y el escrutinio del personal son tan importantes como cualquier medida técnica de seguridad.

La amenaza interna es el principal riesgo restante. Una vez que elimináis los vectores de ataque basados en red, la amenaza restante realista es alguien con acceso físico al sistema. El escrutinio del personal y el registro de acceso se convierten en los controles de seguridad de primera línea.

Probar las actualizaciones antes de desplegarlas importa enormemente. En un entorno conectado, una mala actualización del modelo se puede revertir rápidamente. En un entorno con air gap, revertir significa otro ciclo de transferencia física. Los entornos de staging que reflejen la configuración con air gap ayudan a detectar problemas antes de que lleguen a producción.

La infraestructura energética y de refrigeración necesita planificación. Los sistemas con air gap que ejecutan grandes cargas de trabajo de GPU generan calor sustancial y consumen energía significativa. La planificación de instalaciones necesita tener esto en cuenta desde el principio.

Los requisitos de documentación son extensos. Cada procedimiento que implique al entorno con air gap necesita estar documentado exhaustivamente, no solo por cumplimiento sino porque la consistencia procedimental es lo que previene incidentes de seguridad en los flujos de trabajo de transferencia física.

Los modelos de código abierto son fuertemente preferidos en estos entornos. Los modelos propietarios que requieren llamadas de validación de licencia o informes de telemetría de uso son fundamentalmente incompatibles con el verdadero aislamiento de red. El ecosistema de modelos de código abierto es la base práctica para casi todos los despliegues de IA con air gap.

## **Cuándo la IA con air gap vale cada pizca de la sobrecarga**

La complejidad operativa y el coste adicional de la IA con air gap son reales. Exige más a vuestro equipo, más a vuestras instalaciones y más a vuestros procesos de planificación que cualquier otro enfoque de despliegue. Para las organizaciones donde el modelo de amenazas lo justifica, esa sobrecarga no solo es aceptable, es el objetivo.

El aislamiento en sí es el producto. Todo lo demás que el sistema hace, responder consultas, analizar documentos, detectar anomalías, apoyar decisiones, sucede dentro de un perímetro que ningún actor externo puede alcanzar. Para las organizaciones que necesitan esa garantía, ninguna otra arquitectura la entrega.

## **Preguntas frecuentes**

### **¿Qué es un air gap en IA?**

**Un air gap en IA hace referencia al aislamiento físico y de red completo del sistema de IA, lo que significa sin conexión a internet, sin acceso a redes externas y sin interfaces inalámbricas de ningún tipo.** Los datos se mueven dentro y fuera únicamente a través de transferencias controladas de medios físicos, convirtiéndolo en la arquitectura de despliegue más segura disponible para cargas de trabajo de IA sensibles.

### **¿Qué significa "air gapped"?**

**Air gapped significa que un sistema está físicamente aislado de todas las redes externas, con una brecha literal de aire entre él y cualquier infraestructura conectada.** El término se originó en la informática militar y gubernamental y se ha expandido para describir cualquier despliegue donde el aislamiento de red se utiliza como control de seguridad principal.

### **¿Qué es el trabajo de IA de 900.000 $?**

**El trabajo de IA de 900.000 $ típicamente hace referencia a investigadores de seguridad de IA altamente especializados o científicos principales de IA en las principales empresas tecnológicas cuyos paquetes de compensación total han alcanzado ese rango debido a acciones y bonificaciones.** Los roles que combinan experiencia en ingeniería de IA con acreditaciones de seguridad para entornos clasificados también exigen una compensación excepcional reflejando la escasez de candidatos cualificados que cumplen ambos requisitos.

### **¿Cuál es la regla del 30 % en IA?**

**La regla del 30 % en IA es una directriz que sugiere que la IA debería automatizar aproximadamente el 30 % de un flujo de trabajo dado, dejando el 70 % restante al juicio humano y al razonamiento contextual.** Ayuda a las organizaciones a identificar objetivos realistas de automatización sin sobreingenierizar procesos que aún dependen de la toma de decisiones humana.

### **¿Qué trabajos ya no existirán en 2030?**

**Se espera ampliamente que los roles centrados en entrada repetitiva de datos, procesamiento básico de documentos, gestión rutinaria de consultas de clientes y generación manual de informes declinen significativamente para 2030 a medida que los sistemas de IA absorban esas funciones.** Sin embargo, la mayoría de los analistas proyectan que la transformación del trabajo en lugar de la eliminación total será el patrón dominante, con nuevos roles emergiendo en torno a la gestión, supervisión y despliegue de IA.
