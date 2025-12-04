We will be iterating on the first round of design docs found in @intermediates/22-strandweavejson/round-1. We are assuming that the smallest shareable/reusable config is that of strand (a list of codons, alongside strandweave server runtime settings). We want strandweave config system to support the following scenarios:

- strandweave config should be self contained and shareable by its creators; it will contain:
    - executable strand (list of codons)
    - recommended settings for the strandweave runtime to for this particular strand
- strandweave server should be able to override settings in a given `strandweave.json` using:
    - local variant of the `strandweave.json`
    - CLI args
    - env variables
- while codons definition and configuration is multi layered (objects), strandweave runtime settings should be flat so that they are clearly mappable to CLI args/env vars: "port" attribute maps to "--port" CLI arg and "STRANDWEAVE_PORT" env var
- `strandweave.json` is the main configuration file for strandweave server and includes the following information:
    - settings for configuring behavior of strandweave runtime in @server/strandweave-runtime.ts
    - strand definition (list of codons)

Strandweave config resolution happens as follows:

1. Look for config at path specified via `--config=<path>`
2. Current working directory (`strandweave.json`)
3. User home `~/.config/strandweave/strandweave.json` (global defaults)

Strandweave server can also accept config override which looks as follows:

```json
{
    // overrides for strand settings from "strandweave.json"
}
```

Strandweave config override resolution happens as follows:

1. Look for config at path specified via `--config-override=<path>`
2. Current working directory (`strandweave.local.json`)
3. User home `~/.config/strandweave/strandweave.local.json` (global defaults)


Settings can also be overridden using CLI args and env vars:

```
CLI args > env vars > strandweave.local.json > strandweave.json > DEFAULT_CONFIG (leftmost wins)
```

Based on the descriptions above create the following:

- examples of strandweave.json and strandweave.local.json overrides, along with CLI args
- comment on the alternative approaches and potential shortcomings of the proposed design