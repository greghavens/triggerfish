# Skills प्लेटफ़ॉर्म

Skills Triggerfish की प्राथमिक विस्तारशीलता तंत्र है। एक skill एक फ़ोल्डर है जिसमें एक `SKILL.md` फ़ाइल होती है -- निर्देश और मेटाडेटा जो agent को plugin लिखे या कस्टम कोड बनाए बिना नई क्षमताएँ देते हैं।

Skills इस प्रकार हैं कि agent नई चीज़ें करना सीखता है: आपका कैलेंडर जाँचना, सुबह की ब्रीफ़िंग तैयार करना, GitHub issues की ट्राइएज करना, साप्ताहिक सारांश तैयार करना। उन्हें marketplace से इंस्टॉल किया जा सकता है, हाथ से लिखा जा सकता है, या agent द्वारा स्वयं लिखा जा सकता है।

## Skill क्या है?

एक skill एक फ़ोल्डर है जिसके मूल में `SKILL.md` फ़ाइल होती है। फ़ाइल में YAML frontmatter (मेटाडेटा) और markdown body (agent के लिए निर्देश) होते हैं। वैकल्पिक सहायक फ़ाइलें -- स्क्रिप्ट, टेम्प्लेट, कॉन्फ़िगरेशन -- इसके साथ रह सकती हैं।

```
morning-briefing/
  SKILL.md
  briefing.ts        # वैकल्पिक सहायक कोड
  template.md        # वैकल्पिक टेम्प्लेट
```

`SKILL.md` frontmatter घोषित करता है कि skill क्या करता है, उसे क्या चाहिए, और कौन सी सुरक्षा बाधाएँ लागू होती हैं:

```yaml
---
name: morning-briefing
description: Prepare a daily morning briefing with calendar, email, and weather
version: 1.0.0
category: productivity
tags:
  - calendar
  - email
  - daily
triggers:
  - cron: "0 7 * * *"
metadata:
  triggerfish:
    classification_ceiling: INTERNAL
    requires_tools:
      - browser
      - exec
    network_domains:
      - api.openweathermap.org
      - www.googleapis.com
---

## निर्देश

जब ट्रिगर किया जाए (दैनिक सुबह 7 बजे) या उपयोगकर्ता द्वारा लागू किया जाए:

1. Google Calendar से आज के कैलेंडर events प्राप्त करें
2. पिछले 12 घंटों के अपठित emails का सारांश बनाएँ
3. उपयोगकर्ता के स्थान के लिए मौसम पूर्वानुमान प्राप्त करें
4. एक संक्षिप्त ब्रीफ़िंग संकलित करें और कॉन्फ़िगर किए गए channel पर वितरित करें

Calendar, Email, और Weather के लिए अनुभागों के साथ ब्रीफ़िंग प्रारूपित करें।
इसे स्कैन करने योग्य रखें -- बुलेट पॉइंट, पैराग्राफ़ नहीं।
```

### Frontmatter फ़ील्ड

| फ़ील्ड                                       | आवश्यक | विवरण                                                            |
| --------------------------------------------- | :-----: | ---------------------------------------------------------------- |
| `name`                                        |   हाँ   | अद्वितीय skill पहचानकर्ता                                        |
| `description`                                 |   हाँ   | Skill क्या करता है इसका मानव-पठनीय विवरण                         |
| `version`                                     |   हाँ   | Semantic version                                                 |
| `category`                                    |   नहीं  | समूहीकरण श्रेणी (productivity, development, communication, आदि) |
| `tags`                                        |   नहीं  | खोज के लिए खोज योग्य टैग                                         |
| `triggers`                                    |   नहीं  | स्वचालित आमंत्रण नियम (cron शेड्यूल, event पैटर्न)              |
| `metadata.triggerfish.classification_ceiling`  |   नहीं  | इस skill की अधिकतम taint सीमा (डिफ़ॉल्ट: `PUBLIC`)              |
| `metadata.triggerfish.requires_tools`          |   नहीं  | Skill जिन tools पर निर्भर है (browser, exec, आदि)               |
| `metadata.triggerfish.network_domains`         |   नहीं  | Skill के लिए अनुमत नेटवर्क endpoints                             |

## Skill प्रकार

Triggerfish तीन प्रकार के skills का समर्थन करता है, नाम टकराव होने पर स्पष्ट प्राथमिकता क्रम के साथ।

### बंडल किए गए Skills

`skills/bundled/` निर्देशिका में Triggerfish के साथ शिप होते हैं। प्रोजेक्ट द्वारा बनाए रखे जाते हैं। हमेशा उपलब्ध।

Triggerfish में दस बंडल किए गए skills शामिल हैं जो agent को पहले दिन से आत्मनिर्भर बनाते हैं:

| Skill                     | विवरण                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tdd**                   | Deno 2.x के लिए Test-Driven Development पद्धति। Red-green-refactor चक्र, `Deno.test()` पैटर्न, `@std/assert` उपयोग, Result type परीक्षण, test helpers।          |
| **mastering-typescript**  | Deno और Triggerfish के लिए TypeScript पैटर्न। Strict mode, `Result<T, E>`, branded types, factory functions, immutable interfaces, `mod.ts` barrels।              |
| **skill-builder**         | नए skills लिखने का तरीका। SKILL.md प्रारूप, frontmatter फ़ील्ड, classification सीमाएँ, स्व-लेखन वर्कफ़्लो, सुरक्षा स्कैनिंग।                                    |
| **integration-builder**   | Triggerfish एकीकरण बनाने का तरीका। सभी छह पैटर्न: channel adapters, LLM providers, MCP servers, storage providers, exec tools, और plugins।                       |
| **git-branch-management** | विकास के लिए Git branch वर्कफ़्लो। Feature branches, atomic commits, `gh` CLI के माध्यम से PR निर्माण, PR ट्रैकिंग, webhooks के माध्यम से review feedback लूप।    |
| **deep-research**         | मल्टी-स्टेप शोध पद्धति। स्रोत मूल्यांकन, समानांतर खोज, संश्लेषण, और उद्धरण प्रारूपण।                                                                         |
| **pdf**                   | PDF दस्तावेज़ प्रसंस्करण। टेक्स्ट निष्कर्षण, सारांशीकरण, और PDF फ़ाइलों से संरचित डेटा निष्कर्षण।                                                              |
| **triggerfish**           | Triggerfish आंतरिक के बारे में स्व-ज्ञान। आर्किटेक्चर, कॉन्फ़िगरेशन, समस्या निवारण, और विकास पैटर्न।                                                           |
| **triggers**              | सक्रिय व्यवहार लेखन। प्रभावी TRIGGER.md फ़ाइलें लिखना, निगरानी पैटर्न, और एस्केलेशन नियम।                                                                      |

ये बूटस्ट्रैप skills हैं -- agent स्वयं को विस्तारित करने के लिए इनका उपयोग करता है। Skill-builder agent को नए skills बनाना सिखाता है, और integration-builder इसे नए adapters और providers बनाना सिखाता है।

अपने स्वयं के बनाने के लिए हैंड्स-ऑन गाइड के लिए [Skills बनाना](/hi-IN/integrations/building-skills) देखें।

### प्रबंधित Skills

**The Reef** (सामुदायिक skill marketplace) से इंस्टॉल किए गए। `~/.triggerfish/skills/` में डाउनलोड और संग्रहीत।

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### Workspace Skills

उपयोगकर्ता द्वारा बनाए गए या [exec environment](./exec-environment) में agent द्वारा लिखे गए। `~/.triggerfish/workspace/<agent-id>/skills/` में agent के workspace में संग्रहीत।

Workspace skills सर्वोच्च प्राथमिकता लेते हैं। यदि आप किसी बंडल किए गए या प्रबंधित skill के समान नाम से skill बनाते हैं, तो आपका संस्करण प्राथमिकता लेता है।

```
प्राथमिकता:  Workspace  >  प्रबंधित  >  बंडल किया गया
```

::: tip इस प्राथमिकता क्रम का मतलब है कि आप हमेशा किसी बंडल किए गए या marketplace skill को अपने स्वयं के संस्करण से ओवरराइड कर सकते हैं। आपके अनुकूलन अपडेट द्वारा कभी अधिलेखित नहीं होते। :::

## Agent स्व-लेखन

एक प्रमुख विभेदक: agent अपने स्वयं के skills लिख सकता है। जब कुछ ऐसा करने को कहा जाता है जो वह नहीं जानता, तो agent `SKILL.md` और सहायक कोड बनाने के लिए [exec environment](./exec-environment) का उपयोग कर सकता है, फिर इसे workspace skill के रूप में पैकेज कर सकता है।

### स्व-लेखन प्रवाह

```
1. आप:   "मुझे हर सुबह नए कार्यों के लिए मेरे Notion की जाँच करनी है"
2. Agent: ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/ पर skill बनाता है
          मेटाडेटा और निर्देशों के साथ SKILL.md लिखता है
          सहायक कोड (notion-tasks.ts) लिखता है
          Exec environment में कोड का परीक्षण करता है
3. Agent: Skill को PENDING_APPROVAL के रूप में चिह्नित करता है
4. आप:   सूचना प्राप्त करते हैं: "नया skill बनाया गया: notion-tasks। समीक्षा और अनुमोदन करें?"
5. आप:   Skill को अनुमोदित करते हैं
6. Agent: दैनिक निष्पादन के लिए skill को cron job में जोड़ता है
```

::: warning सुरक्षा Agent द्वारा लिखे गए skills को सक्रिय होने से पहले हमेशा owner अनुमोदन की आवश्यकता होती है। Agent अपने स्वयं के skills को स्व-अनुमोदित नहीं कर सकता। यह agent को ऐसी क्षमताएँ बनाने से रोकता है जो आपकी निगरानी को बायपास करती हैं। :::

## The Reef <ComingSoon :inline="true" />

The Reef Triggerfish का सामुदायिक skill marketplace है -- एक रजिस्ट्री जहाँ आप skills खोज, इंस्टॉल, प्रकाशित, और साझा कर सकते हैं।

| सुविधा              | विवरण                                              |
| ------------------- | -------------------------------------------------- |
| खोज और ब्राउज़       | श्रेणी, टैग, या लोकप्रियता के आधार पर skills खोजें |
| एक-कमांड इंस्टॉल    | `triggerfish skill install <name>`                  |
| प्रकाशित            | समुदाय के साथ अपने skills साझा करें                 |
| सुरक्षा स्कैनिंग    | सूचीबद्ध करने से पहले दुर्भावनापूर्ण पैटर्न के लिए स्वचालित स्कैनिंग |
| संस्करण             | अपडेट प्रबंधन के साथ Skills का संस्करण होता है      |
| समीक्षा और रेटिंग   | Skill गुणवत्ता पर सामुदायिक प्रतिक्रिया              |

### CLI कमांड

```bash
# Skills खोजें
triggerfish skill search "calendar"

# The Reef से skill इंस्टॉल करें
triggerfish skill install google-cal

# इंस्टॉल किए गए skills सूचीबद्ध करें
triggerfish skill list

# सभी प्रबंधित skills अपडेट करें
triggerfish skill update --all

# The Reef पर skill प्रकाशित करें
triggerfish skill publish

# Skill हटाएँ
triggerfish skill remove google-cal
```

## Skill सुरक्षा सारांश

- Skills अपनी सुरक्षा आवश्यकताओं की अग्रिम घोषणा करते हैं (classification सीमा, tools, नेटवर्क डोमेन)
- Tool एक्सेस policy द्वारा गेटेड है -- `requires_tools: [browser]` वाला skill काम नहीं करेगा यदि browser एक्सेस policy द्वारा अवरुद्ध है
- नेटवर्क डोमेन लागू हैं -- skill उन endpoints तक पहुँच नहीं सकता जो उसने घोषित नहीं किए
- Agent द्वारा लिखे गए skills को स्पष्ट owner/admin अनुमोदन की आवश्यकता है
- सभी skill आमंत्रण policy hooks से गुज़रते हैं और पूरी तरह से ऑडिट किए जाते हैं
