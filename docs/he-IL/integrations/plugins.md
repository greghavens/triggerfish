# תוספים

מפעילים תוסף TypeScript בהגדרות המשתמש באמצעות `enabled: true`. כברירת מחדל הייבוא וההרצה מתבצעים ב־Deno Workers מוגבלים. הם יכולים לקרוא את תיקיית התוסף ולהתחבר רק למארחים וליציאות שב־`declaredEndpoints`. כתיבת קבצים, קריאת סביבת התהליך, הפעלת תהליכי משנה, FFI וגישה למידע מערכת מוגבל חסומות. `trust: trusted` בהגדרות מאפשר ייבוא לתהליך Triggerfish. המפעיל רץ שם אם גם המניפסט מציין `trusted`.

```yaml
plugins:
  weather:
    enabled: true
    trust: sandboxed
```

[מדריך התוספים המלא](/integrations/plugins)
