We will be iterating on the first round of design docs found in @intermediates/22-hankweavejson/round-1. We are assuming that the smallest shareable/reusable config is that of hank (a list of codons, alongside hankweave server runtime settings). We want hankweave config system to support the following scenarios:

- hankweave config should be self contained and shareable by its creators; it will contain:
    - executable hank (list of codons)
    - recommended settings for the hankweave runtime to for this particular hank
- hankweave server should be able to override settings in a given `hankweave.json` using:
    - local variant of the `hankweave.json`
    - CLI args
    - env variables
- while codons definition and configuration is multi layered (objects), hankweave runtime settings should be flat so that they are clearly mappable to CLI args/env vars: "port" attribute maps to "--port" CLI arg and "HANKWEAVE_PORT" env var
- `hankweave.json` is the main configuration file for hankweave server and includes the following information:
    - settings for configuring behavior of hankweave runtime in @server/hankweave-runtime.ts
    - hank definition (list of codons)

Hankweave config resolution happens as follows:

1. Look for config at path specified via `--config=<path>`
2. Current working directory (`hankweave.json`)
3. User home `~/.config/hankweave/hankweave.json` (global defaults)

Hankweave server can also accept config override which looks as follows:

```json
{
    // overrides for hank settings from "hankweave.json"
}
```

Hankweave config override resolution happens as follows:

1. Look for config at path specified via `--config-override=<path>`
2. Current working directory (`hankweave.local.json`)
3. User home `~/.config/hankweave/hankweave.local.json` (global defaults)


Settings can also be overridden using CLI args and env vars:

```
CLI args > env vars > hankweave.local.json > hankweave.json > DEFAULT_CONFIG (leftmost wins)
```

Based on the descriptions above create the following:

- examples of hankweave.json and hankweave.local.json overrides, along with CLI args
- comment on the alternative approaches and potential shortcomings of the proposed design