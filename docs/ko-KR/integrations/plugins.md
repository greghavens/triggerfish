# 플러그인

사용자 설정에서 `enabled: true`로 TypeScript 플러그인을 활성화합니다. 기본적으로 권한이 제한된 Deno Worker에서 가져오고 실행합니다. Worker는 플러그인 디렉터리를 읽고 `declaredEndpoints`에 지정된 호스트와 포트에만 연결할 수 있습니다. 파일 쓰기, 프로세스 환경 읽기, 하위 프로세스 실행, FFI 및 제한된 시스템 정보 접근은 차단됩니다. 설정의 `trust: trusted`는 Triggerfish 프로세스에서 가져오기를 허용하며 매니페스트도 `trusted`이면 실행기도 해당 프로세스에서 실행됩니다.

```yaml
plugins:
  weather:
    enabled: true
    trust: sandboxed
```

[전체 플러그인 가이드](/integrations/plugins)
