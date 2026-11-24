---
title: AI Agents तुमचा खाजगी डेटा Exfiltrate करत आहेत. त्यांना कोण रोखत आहे?
date: 2026-03-10
description: बहुतेक AI agent platforms model ला काय करायचे नाही ते सांगून security enforce
  करतात. Model ला त्यातून बोलून काढता येते. Alternative कसे दिसते ते येथे आहे.
author: Greg Havens
tags:
  - ai
  - ai agents
  - security
  - open source
  - self-hosted
  - prompt injection
  - data exfiltration
  - agent security
  - openclaw
  - triggerfish
draft: false
---
![](/blog/images/gemini_generated_image_i7ytlui7ytlui7yt.jpg)

AI agents उपयुक्त आहेत कारण ते action घेऊ शकतात. तोच संपूर्ण मुद्दा आहे. तुम्ही agent ला तुमच्या tools चा access द्या आणि ते गोष्टी करू शकतो: message पाठवणे, record update करणे, file search करणे, query run करणे, commit push करणे. Demos impressive आहेत. Actual deployments, जर तुम्ही त्यांच्याखालील security model जवळून पाहिले, तर वेगळी कथा आहे.

सध्या कोणी मोठ्याने विचारत नाही असा प्रश्न simple आहे. AI agent ला तुमच्या database, email, calendar, Salesforce instance, GitHub repositories ला write access असताना, ते नको ते करण्यापासून काय रोखत आहे? प्रामाणिक उत्तर, बहुतेक cases मध्ये, system prompt मधील एक वाक्य आहे.

ही आपली सध्याची परिस्थिती आहे.

## Model ला behave करायला सांगण्याची समस्या

आज AI agent deploy करताना, standard security practice म्हणजे system prompt मध्ये instructions लिहिणे. Model ला काय करण्याची परवानगी नाही ते सांगा. कोणते tools off-limits आहेत ते सांगा. Destructive actions घेण्यापूर्वी विचारायला सांगा. काही platforms हे instructions manually लिहिण्याऐवजी UI द्वारे configure करू देतात, पण underlying mechanism सारखीच आहे. तुम्ही model ला rulebook देत आहात आणि ते follow करेल असा विश्वास ठेवत आहात.

![](/blog/images/gemini_generated_image_jmypkqjmypkqjmyp.jpg)

या approach ला एक fundamental flaw आहे. Language models rules execute करत नाहीत. ते tokens predict करतात. हा फरक महत्त्वाचा आहे कारण sufficiently well-crafted prompt model काय predict करतो ते shift करू शकतो, आणि त्यामुळे ते काय करतो. हे prompt injection आहे. हे कोणत्याही particular model मधील bug नाही. हे सर्व या systems कसे काम करतात याची property आहे. Attacker model च्या context मध्ये त्यांचा text टाकू शकल्यास, त्यांच्या instructions तुमच्याशी compete करतात. Model कडे कोणत्या instructions trusted system prompt मधून आल्या आणि कोणत्या malicious document मधून आल्या ज्याचे summarize करण्यास सांगितले होते ते identify करण्याचा कोणताही mechanism नाही. ते फक्त tokens पाहतो.

OpenClaw project, जे जवळपास 300,000 GitHub stars पर्यंत वाढले आहे आणि सध्या सर्वात widely deployed open-source personal agent आहे, ही समस्या पूर्णपणे दृश्यमान आहे. Cisco च्या security team ने third-party skill द्वारे data exfiltration demonstrate केले. Project च्या स्वतःच्या maintainer ने publicly सांगितले की software non-technical users साठी "far too dangerous" आहे. हे fringe concern नाही. हे सर्वात popular agent platform ची acknowledged state आहे.

आणि OpenClaw या बाबतीत special नाही. Minor variations सह same architecture बहुतेक agent platforms मध्ये दिसतो. System prompts किती sophisticated आहेत यात ते भिन्न आहेत. कोणते guardrail instructions include करतात यात ते भिन्न आहेत. त्यांच्यात common आहे ते हे की ते सर्व instructions त्यांना guard करण्याच्या आत राहतात.

## "Outside the model" म्हणजे काय

Architectural alternative म्हणजे enforcement model च्या context बाहेर पूर्णपणे move करणे. Model ला काय करण्याची परवानगी नाही ते सांगणे आणि ते ऐकेल अशी आशा ठेवण्याऐवजी, तुम्ही model आणि घेता येणाऱ्या प्रत्येक action दरम्यान gate ठेवता. Model request produce करतो. Gate rules च्या set विरुद्ध ती request evaluate करतो आणि ती execute होईल का ते ठरवतो. Action allow असावा किंवा नाही याबद्दल model चे मत त्या evaluation चा भाग नाही.

हे उच्चारताना obvious वाटते. इतर प्रत्येक security-sensitive software system कसे काम करतो तसे आहे. "खाते नसलेल्या लोकांना पैसे देऊ नका" असे teller ला सांगून bank secure नाही करत. तुम्ही technical controls ठेवता जे teller ला काय सांगितले गेले त्याकडे दुर्लक्ष करून unauthorized withdrawals impossible करतात. Teller चे behavior social engineering attack ने influence होऊ शकते. Controls नाहीत, कारण त्यांचे conversation नसते.

Triggerfish मध्ये, enforcement layer hooks च्या set द्वारे काम करतो जे प्रत्येक meaningful operation पूर्वी आणि नंतर run होतात. Tool call execute होण्यापूर्वी, hook current session state ला दिलेले ते call permitted आहे का ते check करतो. Output channel ला पोहोचण्यापूर्वी, hook बाहेर flowing data त्या channel साठी appropriate level वर classified आहे का ते check करतो. External data context मध्ये येण्यापूर्वी, hook ते classify करतो आणि session चे taint level त्यानुसार update करतो. हे checks code मध्ये आहेत. ते conversation वाचत नाहीत. त्यांना कशाचेही convince करता येत नाही.

## Session taint आणि ते का महत्त्वाचे आहे

Data classification हे security मधील well-understood concept आहे. बहुतेक platforms जे claim करतात ते handle करतात ते resource ला classification assign करतात आणि requesting entity ला access permission आहे का ते check करतात. तो पर्यंत ते उपयुक्त आहे. Access नंतर काय होते ते miss करतो.

AI agent confidential document access केल्यावर, ते confidential data आता त्याच्या context मध्ये आहे. ते session च्या उर्वरित भागात agent च्या outputs आणि reasoning वर influence करू शकते. Agent different task कडे moved on झाला तरी, confidential context अजूनही तेथे आहे. Agent नंतर lower-classified channel वर action घेतल्यास, public Slack channel ला write करणे, external address ला email पाठवणे, webhook ला posting करणे, ते confidential data सोबत नेऊ शकतो. हे data leakage आहे, आणि original resource वरील access controls ते prevent करण्यासाठी काहीही केले नाही.

![](/blog/images/robot-entry.jpg)

Taint tracking हे gap बंद करण्याचा mechanism आहे. Triggerfish मध्ये, प्रत्येक session ला taint level आहे जो PUBLIC पासून सुरू होतो. Agent higher classification level वरील data touch करताच, session त्या level ला tainted होतो. Taint फक्त वर जातो. ते session च्या आत कधीच खाली जात नाही. त्यामुळे CONFIDENTIAL document access केल्यानंतर PUBLIC channel ला message पाठवण्याचा प्रयत्न केल्यास, write-down check tainted session level विरुद्ध fires होतो. Action blocked होतो model ने काय सांगितले त्यामुळे नाही, पण system ला कोणते data play मध्ये आहे हे माहीत आहे म्हणून.

Model ला या mechanism ची माहिती नाही. ते reference करू शकत नाही, याबद्दल reason करू शकत नाही, किंवा ते manipulate करण्याचा प्रयत्न करू शकत नाही. Taint level session बद्दलचा fact आहे जो enforcement layer मध्ये राहतो, context मध्ये नाही.

## Third-party tools attack surface आहेत

Modern AI agents genuinely useful करणाऱ्या features पैकी एक म्हणजे त्यांची extensibility. तुम्ही tools add करू शकता. Plugins install करू शकता. Model Context Protocol द्वारे agent ला external services शी connect करू शकता. Add केलेले प्रत्येक integration agent काय करू शकतो ते expand करते. Add केलेले प्रत्येक integration attack surface देखील expand करते.

येथील threat model hypothetical नाही. Agent third-party skills install करू शकल्यास, आणि ते skills unknown parties द्वारे distributed आहेत, आणि agent चा security model पूर्णपणे context मध्ये instructions respect करण्यावर rely करतो, तर malicious skill install करवून घेऊन data exfiltrate करू शकतो. Skill trust boundary च्या आत आहे. दोन्ही context मध्ये present असल्यास model ला legitimate skill आणि malicious skill मध्ये फरक करण्याचा कोणताही मार्ग नाही.

Triggerfish मध्ये, MCP Gateway सर्व external tool connections handle करतो. प्रत्येक MCP server invoke होण्यापूर्वी classified असणे आवश्यक आहे. UNTRUSTED servers default blocked आहेत. External server मधील tool data return करतो तेव्हा, तो response POST_TOOL_RESPONSE hook मधून जातो, जे response classify करतो आणि session taint त्यानुसार update करतो. वापरकर्ता कॉन्फिगरेशनमध्ये `enabled: true` ने TypeScript प्लगइन सक्षम करा. डीफॉल्टनुसार आयात व अंमलबजावणी मर्यादित Deno Worker मध्ये होते. Worker प्लगइनची निर्देशिका वाचू शकतो आणि फक्त `declaredEndpoints` मधील होस्ट व पोर्टशी जोडू शकतो. फाइल लेखन, प्रक्रिया वातावरण वाचणे, उपप्रक्रिया, FFI व प्रतिबंधित प्रणाली माहितीचा प्रवेश अवरोधित आहे. `trust: trusted` मुळे Triggerfish प्रक्रियेत आयात करण्याची परवानगी मिळते. मॅनिफेस्टमध्येही `trusted` असल्यास एक्झिक्युटर त्याच प्रक्रियेत चालतो. [संपूर्ण प्लगइन मार्गदर्शक](/mr-IN/integrations/plugins).

या सर्वांचा मुद्दा असा आहे की system चे security properties plugins trustworthy असण्यावर depend करत नाहीत. ते sandbox आणि enforcement layer वर depend करतात, जे plugins मध्ये काय आहे त्यामुळे influenced होत नाहीत.

## Audit problem

AI agent deployment सह काहीतरी चुकले तर तुम्हाला कसे कळेल? बहुतेक platforms conversation log करतात. काही tool calls log करतात. खूप कमी session दरम्यान केलेले security decisions अशा प्रकारे log करतात ज्यामुळे कोणते data कोठे, कोणत्या classification level वर flow झाले आणि कोणते policy violated झाले ते reconstruct करता येते.

हे वाटते त्यापेक्षा जास्त महत्त्वाचे आहे, कारण AI agent secure आहे का हा प्रश्न फक्त real-time attacks prevent करण्याबद्दल नाही. ते agent defined boundaries च्या आत वागले याचे demonstrate करण्याबद्दल आहे, after the fact. Sensitive data handle करणाऱ्या कोणत्याही organization साठी, तो audit trail optional नाही. Compliance prove करण्यासाठी, incidents ला respond करण्यासाठी, आणि तुम्ही ज्यांचा data handle करत आहात त्यांचा विश्वास build करण्यासाठी तसे आहे.

![](/blog/images/glass.jpg)

Triggerfish प्रत्येक operation वर full data lineage maintain करतो. System मध्ये येणाऱ्या प्रत्येक data ला provenance metadata आहे: ते कोठून आले, कोणते classification assign केले, कोणत्या transformations मधून गेले, कोणत्या session ला bound होते. तुम्ही कोणताही output ते produce केलेल्या operations च्या chain मधून trace करू शकता. कोणत्या sources ने given response ला contribute केले ते विचारू शकता. Regulatory review साठी complete chain of custody export करू शकता. हे traditional sense मध्ये logging system नाही. हे provenance system आहे जे entire data flow मध्ये first-class concern म्हणून maintained आहे.

## Actual प्रश्न

AI agent category जलद वाढत आहे. Platforms अधिक capable होत आहेत. Use cases अधिक consequential होत आहेत. लोक production databases, customer records, financial systems, आणि internal communication platforms ला write access असलेले agents deploy करत आहेत. बहुतेक deployments मागील assumption असतो की well-written system prompt sufficient security आहे.

ते नाही. System prompt text आहे. Text दुसऱ्या text ने override होऊ शकतो. तुमच्या agent चा security model म्हणजे model तुमचे instructions follow करेल असे असल्यास, तुम्ही probabilistic behavior असलेल्या system कडून behavioral compliance वर rely करत आहात जे तुम्ही control नाही करत अशा inputs ने influenced होऊ शकते.

प्रत्येक agent platform consider करताना विचारण्यायोग्य प्रश्न असतो की enforcement खरोखर कोठे राहतो. उत्तर model च्या instructions मध्ये असल्यास, हे meaningful risk आहे जे तुमचा agent touch करू शकत असलेल्या data च्या sensitivity सह आणि ते manipulate करण्याचा प्रयत्न करणाऱ्यांच्या sophistication सह scale करतो. उत्तर model पासून independently run होणाऱ्या layer मध्ये असल्यास जे कोणत्याही prompt ने reach करता येत नाही, ही वेगळी परिस्थिती आहे.

तुमच्या systems मधील data real आहे. Agent ला ते exfiltrate करण्यापासून कोण रोखत आहे या प्रश्नाला real उत्तर deserve आहे.
