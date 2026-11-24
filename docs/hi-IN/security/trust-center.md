---
title: Trust Center
description: Triggerfish के लिए सुरक्षा नियंत्रण, अनुपालन स्थिति, और आर्किटेक्चरल पारदर्शिता।
---

# Trust Center

Triggerfish सुरक्षा को LLM परत के नीचे निश्चयात्मक कोड में लागू करता है -- उन
prompts में नहीं जिन्हें मॉडल अनदेखा कर सकता है। पूर्ण तकनीकी स्पष्टीकरण के
लिए [सुरक्षा-प्रथम डिज़ाइन](/hi-IN/security/) पृष्ठ देखें।

## सुरक्षा नियंत्रण

| नियंत्रण                       | स्थिति                          | विवरण                                                                     |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------------------- |
| Sub-LLM Policy प्रवर्तन        | <StatusBadge status="active" /> | आठ निश्चयात्मक hooks हर कार्य को इंटरसेप्ट करते हैं                       |
| डेटा वर्गीकरण प्रणाली          | <StatusBadge status="active" /> | चार-स्तरीय पदानुक्रम अनिवार्य no-write-down प्रवर्तन के साथ               |
| Session Taint ट्रैकिंग          | <StatusBadge status="active" /> | प्रत्येक session एक्सेस किए गए डेटा का उच्चतम वर्गीकरण ट्रैक करती है     |
| अपरिवर्तनीय ऑडिट लॉगिंग        | <StatusBadge status="active" /> | सभी policy निर्णय पूर्ण संदर्भ के साथ लॉग। अक्षम नहीं की जा सकती।       |
| Secrets अलगाव                   | <StatusBadge status="active" /> | Credentials OS keychain या vault में। कभी कॉन्फ़िग फ़ाइलों में नहीं।    |
| Plugin Sandboxing                | <StatusBadge status="active" /> | [पूरा प्लगइन मार्गदर्शक](../integrations/plugins) |
| Open Source कोडबेस              | <StatusBadge status="active" /> | पूर्ण सुरक्षा आर्किटेक्चर Apache 2.0 लाइसेंस प्राप्त और सार्वजनिक रूप से ऑडिट योग्य |
| ज़िम्मेदार प्रकटीकरण कार्यक्रम  | <StatusBadge status="active" /> | परिभाषित प्रतिक्रिया समयरेखा के साथ प्रलेखित भेद्यता रिपोर्टिंग प्रक्रिया |

## गहन रक्षा — 13 स्वतंत्र परतें

पूर्ण [गहन रक्षा](/hi-IN/architecture/defense-in-depth) आर्किटेक्चर प्रलेखन पढ़ें।

## अनुपालन रोडमैप

| प्रमाणन                  | स्थिति                           | नोट्स                                            |
| ------------------------ | -------------------------------- | ------------------------------------------------ |
| SOC 2 Type I             | <StatusBadge status="planned" /> | Security + Confidentiality trust services मानदंड  |
| SOC 2 Type II            | <StatusBadge status="planned" /> | अवलोकन अवधि में निरंतर नियंत्रण प्रभावशीलता      |
| HIPAA BAA                | <StatusBadge status="planned" /> | स्वास्थ्य सेवा ग्राहकों के लिए business associate समझौता |
| ISO 27001                | <StatusBadge status="planned" /> | सूचना सुरक्षा प्रबंधन प्रणाली                     |

## स्रोत ऑडिट करें

पूर्ण Triggerfish कोडबेस
[github.com/greghavens/triggerfish](https://github.com/greghavens/triggerfish) पर
उपलब्ध है — Apache 2.0 लाइसेंस प्राप्त।

## भेद्यता रिपोर्टिंग

यदि आपको कोई सुरक्षा भेद्यता मिलती है, तो कृपया हमारी
[ज़िम्मेदार प्रकटीकरण नीति](/hi-IN/security/responsible-disclosure) के माध्यम से
रिपोर्ट करें।
