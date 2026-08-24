# OwnContext 공개 Windows 배포 런북

이 문서는 NextH의 신뢰 형성과 유입이라는 제품 목적을 지키면서, 무료 Windows
EXE를 공개하기 전에 운영자가 확인해야 할 입력과 증적을 한곳에 모은다. 문서의
명령은 공개를 자동 승인하지 않는다. 라이선스·서명 인증서·보안 증적·GitHub
권한이 실제로 제공된 경우에만 보호된 릴리스 환경에서 실행한다.

## 현재 판정

로컬 개발, unsigned 패키징, 테스트, 초안 증적 생성은 계속할 수 있다. 그러나
현재 `node scripts/release-preflight.mjs --json`의 `publicRelease`는 `false`이며
다음 게이트가 남아 있다.

- non-placeholder semver 버전
- canonical public GitHub origin
- 프로젝트 오픈소스 라이선스 선택과 최상위 `LICENSE`
- 보호된 공개 빌드 프로필과 명시적 maintainer 승인
- 조직 소유 Authenticode 인증서와 비밀번호
- HTTPS Squirrel update channel
- 보안 attestation
- GitHub-hosted `windows-latest`의 실제 설치·MCP·검색·fetch·삭제 lifecycle 증적

라이선스가 아직 보류 상태이므로 이 런북은 라이선스를 선택하지 않는다. 무료
EXE라는 가격 정책만으로 소스코드의 사용·수정·재배포 권한이 부여되지는 않는다.

## 공개 전 운영자 입력

### 저장소와 프로젝트 메타데이터

1. 공개 GitHub 저장소를 만들고 canonical `origin`을 설정한다.
2. 루트와 모든 `@owncontext/*` workspace의 버전을 하나의 non-placeholder
   semver로 맞춘다.
3. 라이선스를 결정하고 완전한 `LICENSE` 파일 및 package metadata를 일치시킨다.
   결정 근거와 maintainer 승인을 저장소 기록으로 남긴다. 공개 릴리스 승인은
   `LICENSE-STATUS.md`에 정확히 `Public release license approval: approved`를
   기록해야 하며, 파일과 metadata만 추가하는 것으로는 게이트가 열리지 않는다.
4. 공개 목적(무료 개인 데이터 자산화, 신뢰 형성, NextH 유입)을 README와 릴리스
   노트에서 과장 없이 설명한다. 사용자의 데이터가 자동으로 외부로 전송된다고
   오해할 표현은 넣지 않는다.

### GitHub protected environment

환경 이름은 정확히 `owncontext-public-release`로 만든다. 아래 secret은 저장소나
로그에 평문으로 넣지 않는다.

| 종류 | 이름 | 용도 |
| --- | --- | --- |
| secret | `OWNCONTEXT_SIGNING_CERTIFICATE_BASE64` | 조직 소유 Authenticode PFX의 base64 |
| secret | `OWNCONTEXT_SIGNING_CERTIFICATE_PASSWORD` | PFX 비밀번호 |
| secret | `OWNCONTEXT_SECURITY_ATTESTATION_BASE64` | 검증된 보안 attestation JSON |
| variable | `OWNCONTEXT_TIMESTAMP_SERVER` | 서명 timestamp 서버의 HTTPS URL |
| variable | `OWNCONTEXT_UPDATE_URL` | immutable HTTPS Squirrel `RELEASES` 채널 |
| variable | `OWNCONTEXT_SIGNING_WEBSITE` | 서명 주체의 검증 가능한 웹사이트 |

`OWNCONTEXT_PUBLIC_RELEASE_APPROVAL=true`는 보호된 job 안에서만 주입한다. 이
값을 로컬 셸이나 일반 CI job에 넣는 것은 공개 승인이 아니다.

## 실행 순서

태그와 workflow dispatch 모두 `v` 접두사를 허용하며 workflow가 이를 제거한다.
예시는 운영자가 최종 버전과 공개 저장소를 확정한 뒤 실행한다.

```powershell
# 변경·버전·LICENSE를 검토한 뒤
git status --short
git tag vX.Y.Z
git push origin main --follow-tags

# 또는 GitHub Actions에서 OwnContext public release를 dispatch하고
# version에 X.Y.Z를 입력한다.
```

workflow는 GitHub-hosted disposable `windows-latest`에서 다음을 순서대로 수행한다.

1. lockfile 설치와 `npm run check`
2. protected certificate/attestation 임시 파일 복호화
3. `OWNCONTEXT_RELEASE_PROFILE=public` Windows x64 빌드·서명
4. source-bound bundle 및 maker/payload 증적 검증
5. 설치·실행·암호화 MCP broker 검색/가져오기·설정 보존·삭제 lifecycle 실행
6. lifecycle 결과를 포함해 bundle 재생성 및 최종 preflight
7. 모든 게이트가 통과한 경우에만 GitHub Release 생성

## 로컬 사전 점검

공개 입력을 넣기 전에는 아래 명령으로 현재 경계를 확인한다.

```powershell
node scripts/release-preflight.mjs --json
npm run check
npm run test:release-bundle
```

로컬 `npm run make --workspace @owncontext/desktop` 결과는 개발 초안이다. 실제
공개 증적은 보호된 workflow의 signed artifact와 hosted lifecycle 결과여야 한다.

## 실패 시 해석

- `project-license`: 라이선스를 임의로 추가하지 말고 maintainer 결정을 먼저 기록한다.
  파일·metadata와 별도로 `LICENSE-STATUS.md`의 명시적 공개 승인 표식이 필요하다.
- `authenticode-signing`: 인증서 파일·비밀번호를 커밋하거나 채팅에 붙여 넣지 않는다.
- `security-attestation`: 현재 broker 구현과 로컬 smoke는 기반 검증일 뿐, DACL,
  crash/restart, backup, key rotation까지 포함한 공개 승인 증적이 아니다.
- `clean-machine-lifecycle`: 로컬 PC에서 통과한 설치는 hosted clean-machine
  증적을 대체하지 않는다.
- `update-channel`: 변경 가능한 파일 호스팅 URL을 사용하지 말고, 서명된
  Squirrel `RELEASES`의 immutable HTTPS 경로를 검증한다.

## 공개 후 확인

Release가 만들어진 뒤 운영자는 새 Windows 사용자 계정 또는 disposable VM에서
설치·업데이트·삭제를 다시 확인하고, README의 다운로드 링크·보안 모델·데이터
보관 경계를 실제 Release asset과 대조한다. 이 확인은 NextH의 신뢰를 높이는
제품 경험의 일부이며, 측정되지 않은 telemetry를 추가하는 근거가 아니다.
