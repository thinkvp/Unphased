## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Checks

- [ ] `cd engine && npm test`
- [ ] `cd uxp && npm run lint && npm test`
- [ ] If `engine/src/` or `cep/js/pairing.js` changed: ran `cd uxp && npm run build:engine`
      and committed the regenerated `uxp/js/engine/*` and `uxp/js/pairing.js`
- [ ] If the UI changed in one panel, the other panel got the same edit where it applies

## DSP changes only

<!-- Delete this section if the change does not touch alignment maths. -->

Null depth on the `testmedia/` fixtures, before → after:

| clip | before | after |
| --- | --- | --- |
| lav1 |  |  |
| lav2 |  |  |

## Verified in Premiere?

<!-- Which host and version, or "offline tests only". The UXP host layer in
     particular is not covered by the offline suites. -->
