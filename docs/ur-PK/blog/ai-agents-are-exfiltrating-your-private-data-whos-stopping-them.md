---
title: AI Agents آپ کا Private Data چرا رہے ہیں۔ انہیں کون روک رہا ہے؟
date: 2026-03-10
description: زیادہ تر AI agent platforms security model کو بتا کر enforce کرتے
  ہیں کہ کیا نہ کرے۔ Model کو اس سے explain کیا جا سکتا ہے۔ Alternative کیسا
  دکھتا ہے۔
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

AI agents اس لیے مفید ہیں کیونکہ وہ action لے سکتے ہیں۔ یہی پوری بات ہے۔ آپ ایک agent کو اپنے tools تک access دیتے ہیں، اور یہ کام کر سکتا ہے: message بھیجنا، record update کرنا، file search کرنا، query چلانا، commit push کرنا۔ Demos impressive ہیں۔ Actual deployments، اگر آپ ان کے نیچے کے security model پر قریب سے نظر ڈالیں، تو مختلف کہانی ہے۔

وہ سوال جو ابھی کوئی کافی بلند آواز سے نہیں پوچھ رہا وہ simple ہے۔ جب کوئی AI agent آپ کے database، email، calendar، Salesforce instance، GitHub repositories تک write access رکھتا ہے، تو اسے کچھ ایسا کرنے سے کون روک رہا ہے جو نہیں کرنا چاہیے؟ زیادہ تر cases میں honest جواب system prompt میں ایک sentence ہے۔

یہ وہ صورتحال ہے جس میں ہم ہیں۔

## Model کو behave کرنے کا کہنے کا مسئلہ

جب آج آپ کوئی AI agent deploy کرتے ہیں تو standard security practice یہ ہے کہ system prompt میں instructions لکھیں۔ Model کو بتائیں کیا کرنے کی اجازت نہیں۔ بتائیں کون سے tools off-limits ہیں۔ بتائیں کہ destructive actions سے پہلے پوچھے۔ کچھ platforms آپ کو یہ instructions manually لکھنے کی بجائے UI کے ذریعے configure کرنے دیتے ہیں، لیکن underlying mechanism ایک ہی ہے۔ آپ model کو ایک rulebook دے رہے ہیں اور trust کر رہے ہیں کہ وہ اس کے ساتھ چلے گا۔

![](/blog/images/gemini_generated_image_jmypkqjmypkqjmyp.jpg)

اس approach میں ایک fundamental flaw ہے۔ Language models rules execute نہیں کرتے۔ وہ tokens predict کرتے ہیں۔ یہ distinction اس لیے اہم ہے کیونکہ کافی اچھا crafted prompt یہ بدل سکتا ہے جو model predict کرتا ہے، اور اس لیے یہ کیا کرتا ہے۔ یہ prompt injection ہے۔ یہ کسی خاص model میں bug نہیں ہے۔ یہ اس طرح کام کرنے کی property ہے۔ اگر کوئی attacker اپنا text model کے context میں ڈال سکے تو ان کی instructions آپ کی instructions سے compete کرتی ہیں۔ Model کے پاس یہ identify کرنے کا کوئی mechanism نہیں کہ کون سی instructions trusted system prompt سے آئیں اور کون سی کسی malicious document سے جسے summarize کرنے کو کہا گیا۔ یہ صرف tokens دیکھتا ہے۔

OpenClaw project، جو تقریباً 300,000 GitHub stars تک پہنچ گیا ہے اور شاید ابھی سب سے زیادہ widely deployed open-source personal agent ہے، یہ مسئلہ پوری طرح سامنے رکھتا ہے۔ Cisco کی security team نے ایک third-party skill کے ذریعے data exfiltration demonstrate کیا۔ Project کے اپنے maintainer نے publicly کہا کہ software "non-technical users کے لیے بہت زیادہ dangerous" ہے۔ یہ fringe concern نہیں ہے۔ یہ سب سے popular agent platform کی acknowledged state ہے۔

اور OpenClaw اس regard میں special نہیں ہے۔ ایک ہی architecture، minor variations کے ساتھ، market پر زیادہ تر agent platforms میں نظر آتی ہے۔ وہ اس میں vary کرتے ہیں کہ ان کے system prompts کتنے sophisticated ہیں۔ وہ اس میں vary کرتے ہیں کہ وہ کتنے guardrail instructions شامل کرتے ہیں۔ جو چیز ان میں common ہے وہ یہ ہے کہ وہ تمام instructions اس چیز کے اندر ہیں جس کی وہ حفاظت کرنی چاہتے ہیں۔

## "Model سے باہر" کا اصل مطلب

Architectural alternative یہ ہے کہ enforcement کو model کے context سے باہر منتقل کریں۔ Model کو بتانے کی بجائے کہ اسے کیا کرنے کی اجازت نہیں اور امید کریں کہ یہ سنے گا، آپ model اور ہر action کے درمیان جو وہ لے سکتا ہے ایک gate رکھیں۔ Model ایک request produce کرتا ہے۔ Gate اس request کو rules کے set کے خلاف evaluate کرتا ہے اور فیصلہ کرتا ہے کہ آیا یہ execute ہو گا۔ کیا action allowed ہونی چاہیے اس بارے میں model کی رائے اس evaluation کا حصہ نہیں ہے۔

یہ زور سے کہنے پر obvious لگتا ہے۔ ہر دوسرا security-sensitive software system اسی طرح کام کرتا ہے۔ آپ bank کو secure نہیں کرتے teller کو یہ کہہ کر کہ "جن لوگوں کے accounts نہیں ہیں انہیں پیسے مت دو۔" آپ technical controls رکھتے ہیں جو unauthorized withdrawals کو impossible بناتے ہیں چاہے teller کو کچھ بھی بتایا جائے۔ Teller کا behavior کسی social engineering attack سے influence ہو سکتا ہے۔ Controls نہیں ہوتے، کیونکہ ان کی کوئی conversation نہیں ہوتی۔

Triggerfish میں، enforcement layer hooks کے ایک set کے ذریعے کام کرتی ہے جو ہر meaningful operation سے پہلے اور بعد چلتے ہیں۔ کوئی tool call execute ہونے سے پہلے، hook check کرتا ہے کہ آیا وہ call موجودہ session state کو دیکھتے ہوئے permitted ہے۔ Output کوئی channel reach کرنے سے پہلے، hook check کرتا ہے کہ آیا باہر جانے والا data اس channel کے لیے مناسب level پر classified ہے۔ External data context میں enter ہونے سے پہلے، hook اسے classify کرتا ہے اور session کا taint level اسی کے مطابق update کرتا ہے۔ یہ checks code میں ہیں۔ یہ conversation نہیں پڑھتے۔ انہیں کسی چیز کا قائل نہیں کیا جا سکتا۔

## Session taint اور اس کی اہمیت

Data classification security میں ایک well-understood concept ہے۔ زیادہ تر platforms جو اسے handle کرنے کا دعوی کرتے ہیں resource کو ایک classification assign کرتے ہیں اور check کرتے ہیں کہ آیا requesting entity کو access کی permission ہے۔ یہ جب تک جاتا ہے مفید ہے۔ جو یہ miss کرتا ہے وہ یہ ہے کہ access کے بعد کیا ہوتا ہے۔

جب کوئی AI agent کوئی confidential document access کرتا ہے تو وہ confidential data اب اس کے context میں ہے۔ یہ session کے باقی حصے کے لیے agent کے outputs اور reasoning کو influence کر سکتا ہے۔ یہاں تک کہ اگر agent کوئی مختلف task کی طرف move کرے، confidential context ابھی بھی موجود ہے۔ اگر agent پھر lower-classified channel پر کوئی action لے، public Slack channel پر لکھنا، external address پر email بھیجنا، webhook پر post کرنا، تو یہ اپنے ساتھ confidential data لے جا سکتا ہے۔ یہ data leakage ہے، اور original resource پر access controls نے اسے روکنے کے لیے کچھ نہیں کیا۔

![](/blog/images/robot-entry.jpg)

Taint tracking وہ mechanism ہے جو اس gap کو بند کرتی ہے۔ Triggerfish میں، ہر session کا ایک taint level ہے جو PUBLIC سے شروع ہوتا ہے۔ جیسے ہی agent higher classification level پر data touch کرے، session اس level تک tainted ہو جاتی ہے۔ Taint صرف اوپر جاتا ہے۔ یہ session کے اندر کبھی نیچے نہیں جاتا۔ تو اگر آپ CONFIDENTIAL document access کریں اور پھر PUBLIC channel کو message بھیجنے کی کوشش کریں تو write-down check tainted session level کے خلاف fire کرتی ہے۔ Action block ہو جاتا ہے نہ کہ model نے کچھ کہا کیونکہ بلکہ اس لیے کہ system جانتا ہے کہ کون سا data play میں ہے۔

Model کو اس mechanism کا کوئی علم نہیں۔ یہ اسے reference نہیں کر سکتا، اس کے بارے میں reason نہیں کر سکتا، یا اسے manipulate کرنے کی کوشش نہیں کر سکتا۔ Taint level session کے بارے میں ایک fact ہے جو enforcement layer میں رہتا ہے، context میں نہیں۔

## Third-party tools ایک attack surface ہیں

جو چیز modern AI agents کو genuinely useful بناتی ہے وہ بھی یہی ہے جو انہیں کبھی کبھار alarming بناتی ہے: ان کی extensibility۔ آپ tools add کر سکتے ہیں۔ آپ plugins install کر سکتے ہیں۔ آپ agent کو Model Context Protocol کے ذریعے external services سے connect کر سکتے ہیں۔ ہر integration جو آپ add کرتے ہیں agent کو مزید کام کرنے کی صلاحیت دیتی ہے۔ ہر integration جو آپ add کرتے ہیں attack surface بھی بڑھاتی ہے۔

یہاں threat model hypothetical نہیں ہے۔ اگر کوئی agent third-party skills install کر سکے، اور وہ skills unknown parties کے ذریعے distribute ہوں، اور agent کا security model پوری طرح اس پر rely کرے کہ model اپنے context میں instructions respect کرے گا، تو کوئی malicious skill صرف install ہو کر data exfiltrate کر سکتی ہے۔ Skill trust boundary کے اندر ہے۔ Model کے پاس legitimate skill اور malicious skill کے درمیان distinguish کرنے کا کوئی طریقہ نہیں اگر دونوں context میں موجود ہوں۔

Triggerfish میں، MCP Gateway تمام external tool connections handle کرتا ہے۔ ہر MCP server کو invoke کیے جانے سے پہلے classify کرنا ضروری ہے۔ UNTRUSTED servers بطور ڈیفالٹ block ہیں۔ جب کوئی external server سے tool data return کرے تو وہ response POST_TOOL_RESPONSE hook سے گزرتا ہے جو response classify کرتا ہے اور session taint اسی کے مطابق update کرتا ہے۔ صارف کی ترتیب میں `enabled: true` کے ذریعے TypeScript پلگ ان فعال کریں۔ پہلے سے طے شدہ حالت میں درآمد اور اجرا محدود Deno Workers میں ہوتے ہیں۔ Worker پلگ ان کی ڈائریکٹری پڑھ سکتا ہے اور صرف `declaredEndpoints` میں درج میزبانوں اور پورٹس سے جڑ سکتا ہے۔ فائل لکھنے، عمل کے ماحول کو پڑھنے، ذیلی عمل چلانے، FFI اور محدود نظامی معلومات تک رسائی مسدود ہے۔ `trust: trusted` سے Triggerfish کے عمل میں درآمد کی اجازت ملتی ہے۔ اگر مینی فیسٹ بھی `trusted` ہو تو ایکزیکیوٹر وہیں چلتا ہے۔ [پلگ ان کی مکمل رہنمائی](/ur-PK/integrations/plugins).

ان سب کی بات یہ ہے کہ system کی security properties اس بات پر depend نہیں کرتیں کہ plugins trustworthy ہوں۔ وہ sandbox اور enforcement layer پر depend کرتی ہیں، جو plugins میں کیا ہے اس سے influenced نہیں ہوتے۔

## Audit problem

اگر آج AI agent deployment میں کچھ غلط ہو تو آپ کو کیسے پتہ چلے گا؟ زیادہ تر platforms conversation log کرتے ہیں۔ کچھ tool calls log کرتے ہیں۔ بہت کم ایسے طریقے سے session کے دوران کیے گئے security decisions log کرتے ہیں جو آپ کو یہ reconstruct کرنے دے کہ کون سا data کہاں flow ہوا، کس classification level پر، اور آیا کوئی policy violate ہوئی۔

یہ اس سے زیادہ اہم ہے جتنا لگتا ہے، کیونکہ یہ سوال کہ آیا کوئی AI agent secure ہے صرف real time میں attacks روکنے کے بارے میں نہیں ہے۔ یہ اس بارے میں ہے کہ بعد از fact demonstrate کر سکیں کہ agent نے defined boundaries کے اندر behave کیا۔ کوئی بھی organization جو sensitive data handle کرتی ہے، اس audit trail کے لیے کوئی option نہیں ہے۔ یہ آپ کا طریقہ ہے کہ آپ compliance prove کریں، incidents کا جواب دیں، اور ان لوگوں کے ساتھ trust بنائیں جن کا data آپ handle کر رہے ہیں۔

![](/blog/images/glass.jpg)

Triggerfish ہر operation پر complete data lineage maintain کرتا ہے۔ ہر وہ data جو system میں enter کرتا ہے provenance metadata carry کرتا ہے: یہ کہاں سے آیا، اسے کون سی classification assign ہوئی، کن transformations سے گزرا، یہ کس session سے bound تھا۔ آپ کسی بھی output کو operations کی chain کے ذریعے trace کر سکتے ہیں جس نے اسے produce کیا۔ آپ پوچھ سکتے ہیں کہ کون سے sources نے کسی مخصوص response میں contribute کیا۔ آپ regulatory review کے لیے complete chain of custody export کر سکتے ہیں۔ یہ traditional sense میں logging system نہیں ہے۔ یہ ایک provenance system ہے جو پورے data flow میں first-class concern کے طور پر maintain ہوتا ہے۔

## اصل سوال

AI agent category تیزی سے بڑھ رہی ہے۔ Platforms زیادہ capable ہو رہے ہیں۔ Use cases زیادہ consequential ہو رہے ہیں۔ لوگ production databases، customer records، financial systems، اور internal communication platforms تک write access کے ساتھ agents deploy کر رہے ہیں۔ ان deployments کے پیچھے assumption یہ ہے کہ ایک well-written system prompt کافی security ہے۔

یہ نہیں ہے۔ System prompt text ہے۔ Text کو دوسرے text سے override کیا جا سکتا ہے۔ اگر آپ کے agent کا security model یہ ہے کہ model آپ کی instructions follow کرے گا تو آپ ایک ایسے system سے behavioral compliance پر rely کر رہے ہیں جس کا behavior probabilistic ہے اور ان inputs سے influenced ہو سکتا ہے جو آپ control نہیں کرتے۔

ہر agent platform کے بارے میں جس پر آپ غور کر رہے ہیں یہ پوچھنے کے قابل سوال یہ ہے کہ enforcement actually کہاں رہتا ہے۔ اگر جواب model کی instructions میں ہے، تو یہ ایک meaningful risk ہے جو اس data کی sensitivity کے ساتھ scale کرتی ہے جو آپ کا agent touch کر سکتا ہے اور ان لوگوں کی sophistication کے ساتھ جو اسے manipulate کرنے کی کوشش کر سکتے ہیں۔ اگر جواب ایک ایسی layer میں ہے جو model سے independently چلتی ہے اور کسی بھی prompt سے نہیں پہنچی جا سکتی، تو یہ ایک مختلف صورتحال ہے۔

آپ کے systems میں data حقیقی ہے۔ یہ سوال کہ agent کو اسے exfiltrate کرنے سے کون روک رہا ہے، ایک حقیقی جواب کا حق رکھتا ہے۔
