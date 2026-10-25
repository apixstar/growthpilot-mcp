# Source selection policy

Apply these defaults when the user has not selected a source. The provider comparison supplied for this product guides the preferences; availability, the actual report schema and returned evidence determine what can be delivered. Do not copy its pricing claims or treat approximate coverage thresholds as guarantees.

## Strongest fit and limits

| Source | Prefer for | Interpretation / availability limits |
| --- | --- | --- |
| Similarweb | Whole-site traffic and growth, channel mix, referral traffic, geography, engagement and audience comparisons; industry or tool-market sizing | Small/new sites can have sparse or unstable estimates. Missing data does not prove zero traffic. Do not impose a hard monthly-visit cutoff from the comparison image. Traffic may include direct/social/referral sources that an SEO estimate omits. The current APIxStar Grow Similarweb schema is for websites; do not promise App reports just because the vendor offers them. |
| Semrush | Broad SEO and content/keyword research, country-specific keyword databases, keyword gaps, PPC ad copies/history and shopping ads | A broad vendor suite does not mean all features are implemented here. Check category discovery, report schema, evidence, channel and permissions. Local SEO, social management, site audit and tracking are not supported merely because they appear in the vendor comparison. SEO traffic estimates are not total visits. Database acceptance is not proof of verified coverage for every country. |
| Ahrefs | Backlink/referring-domain depth and history, backlink gaps, backlink-based KD, and focused competitor top pages / organic keywords | APIxStar Grow exposes implemented reports through its enabled `3ue` browser channel. Check `ahrefs_discover` and `ahrefs_get_report_schema`; empty categories are unsupported and source quota can restrict reports. Use a suitable Semrush fallback only when coverage is unavailable, not to bypass authorization or quota errors. Do not treat organic-traffic estimates as whole-site traffic. New-term volume can lag; zero is not proof of no demand. KD methodologies differ and must not be averaged across vendors. |
| Google Trends | Search-interest direction, emerging/rising terms, seasonality and relative comparisons | This is an additional default for the existing Trends integration, not a ranking taken from the supplied image. Use only when enabled. Interest scores are normalized, not visit counts or absolute search volume. Keep time range, geography, category, search property and comparison normalization explicit. Low volume, missing values and `Breakout` require their own labels. |

## Resolve overlapping capabilities

- **“How much traffic does this competitor get?”** Default to Similarweb whole-site traffic. Semrush/Ahrefs organic-search traffic answers a narrower question; label it as such rather than using it as a replacement.
- **“Find SEO opportunities / country keywords / keyword gaps.”** Default to Semrush. For a narrow top-pages / organic-keywords exploration, prefer an available Ahrefs report; use Semrush when Ahrefs is absent. If the same request needs country databases, gaps or PPC alongside pages, favor the relevant Semrush reports rather than adding Ahrefs solely for a second version of the same metric.
- **“Where does referral traffic come from?”** Use Similarweb. **“Which sites link here?”** Prefer Ahrefs, then Semrush. A referral-visit report is not a backlink index.
- **“What ads does this competitor run?”** Default to Semrush paid-search/shopping reports. Similarweb `ppcSpend` is a narrower search-ad spend estimate, not an ad-copy/history report or total advertising spend.
- **“Is this new term taking off?”** Default to enabled Google Trends for relative interest. Add Semrush absolute volume/KD only if the question also needs those metrics; lagging keyword estimates alone cannot reject a new opportunity.

## Bounded fallback

1. Reuse an existing task/result for the same scope before submitting more paid work. A task ID stays with its originating provider; source preferences never reroute a running task.
2. If the user named a source or channel, preserve it. If it is unavailable or incapable of the requested metric, explain the gap and obtain the user's source choice before a paid substitute, unless they already authorized alternatives.
3. With no explicit source, check the preferred source's tool, enabled channel and report availability before spending. If unavailable, choose one suitable available fallback and name it. A fallback must preserve the metric, target, required filters and period; otherwise return the partial answer or ask about the necessary change.
4. For materially missing coverage, a single suitable fallback is reasonable only within the requested scope and spending limit. Do not sweep every vendor. Stop if that fallback is also unsuitable. Authentication, permission, rate-limit and quota failures are stopping conditions, not an invitation to bypass access controls or buy another service.
5. Keep sources separate in the output. Do not average vendors' incompatible estimates or silently stitch their time series. Explain disagreements in metric, scope, period or methodology before drawing a conclusion. State the provider, Semrush channel/source origin where applicable, actual coverage, missing fields and whether the data is an estimate.

## Mixed research examples

- **Evaluate a tool-site market:** start with Similarweb traffic/channel/engagement comparison for the relevant competitors. Add Semrush keyword-gap or PPC reports only for requested search or acquisition opportunities. Add Trends only for a requested emerging-demand dimension; do not run all three automatically.
- **Small site with missing Similarweb traffic:** report the traffic limitation. Semrush/Ahrefs can describe organic visibility if that helps the requested question, but cannot establish total site traffic or disprove traffic from TikTok, Reddit or direct visits.
- **“Use Similarweb for keywords”:** use its keyword report. Explain its scope if material, but do not switch to the usual Semrush default.
- **“Use Ahrefs for backlinks,” with no Ahrefs tool:** report that this connection lacks Ahrefs and offer Semrush; wait for an answer before submitting that paid substitute unless fallback was already authorized.
