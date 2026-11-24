# پلگ ان

صارف کی ترتیب میں `enabled: true` کے ذریعے TypeScript پلگ ان فعال کریں۔ پہلے سے طے شدہ حالت میں درآمد اور اجرا محدود Deno Workers میں ہوتے ہیں۔ Worker پلگ ان کی ڈائریکٹری پڑھ سکتا ہے اور صرف `declaredEndpoints` میں درج میزبانوں اور پورٹس سے جڑ سکتا ہے۔ فائل لکھنے، عمل کے ماحول کو پڑھنے، ذیلی عمل چلانے، FFI اور محدود نظامی معلومات تک رسائی مسدود ہے۔ `trust: trusted` سے Triggerfish کے عمل میں درآمد کی اجازت ملتی ہے۔ اگر مینی فیسٹ بھی `trusted` ہو تو ایکزیکیوٹر وہیں چلتا ہے۔

```yaml
plugins:
  weather:
    enabled: true
    trust: sandboxed
```

[پلگ ان کی مکمل رہنمائی](/integrations/plugins)

## The Reef: Plugin Marketplace

Plugins کو The Reef سے publish اور install کیا جا سکتا ہے، وہی marketplace جو skills
کے لیے استعمال ہوتا ہے۔

### CLI Commands

```bash
triggerfish plugin search "weather"     # Plugins تلاش کریں
triggerfish plugin install weather      # The Reef سے install کریں
triggerfish plugin update               # Updates چیک کریں
triggerfish plugin publish ./my-plugin  # Publishing کے لیے تیار کریں
triggerfish plugin scan ./my-plugin     # Security scan
triggerfish plugin list                 # Installed plugins list کریں
```
