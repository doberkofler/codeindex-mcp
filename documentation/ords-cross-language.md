# ORDS and Cross-Language Resolution

**Status:** planned

## 1. Scope

This adapter family connects language-native facts through HTTP and Oracle REST
Data Services (ORDS) to Oracle objects. It supports both REST modules and
configurations that dispatch a path directly to a stored routine.

The design is deployment-neutral. Workspace paths, URL prefixes, schema names,
pool names, endpoint names, authorization functions, and network topology are
configuration or extracted facts—not package defaults.

## 2. Evidence sources

Keep these sources independent:

- application call sites and endpoint constants;
- checked-in reverse-proxy and ORDS configuration;
- live ORDS metadata, when a read-only metadata adapter is configured;
- Oracle dictionary objects, routines, overloads, synonyms, and arguments;
- optional development runtime observations;
- deployment provenance.

Checked-in configuration identifies editable intent. Live metadata identifies
deployed state. Runtime observations identify sampled behavior. None silently
overwrites another.

## 3. Route model

A route fact records, where applicable:

- source locator and configuration digest;
- public/private or other configured exposure class;
- HTTP method;
- exact, prefix, template, or regular-expression match kind;
- path pattern and template parameters;
- proxy target or ORDS pool;
- ORDS module, base path, template, and handler;
- target schema/object/routine candidate;
- authorization, validation, privilege, or role metadata;
- confidence and unresolved reason.

Secrets, host credentials, request values, headers, cookies, IP addresses, and
database connection strings are prohibited.

## 4. Resolution pipelines

Supported pipelines include:

```text
application caller
  → HTTP wrapper/client
  → literal or partially resolved endpoint
  → reverse-proxy route
  → ORDS pool/schema context
  → ORDS module/template/handler or direct routine dispatch
  → Oracle object/routine/overload
```

and:

```text
operation or tool registry
  → shared operation name
  → endpoint constant
  → HTTP client
  → route and ORDS context
  → Oracle routine
```

A registry entry does not prove a database target unless the intermediate mapping
exists. A matching routine name does not prove a route unless route and schema
context resolve.

## 5. Resolution order

Resolve in precision order:

1. construct a finite Oracle name universe from objects, routines, overloads, and
   synonyms;
2. extract literal endpoint calls and fixed endpoint constants;
3. connect operation names to endpoint constants where explicit shared identity
   exists;
4. resolve reverse-proxy and ORDS route configuration;
5. establish target owner/schema context;
6. validate object and routine existence against Oracle metadata;
7. narrow overloads with verified HTTP method, handler metadata, named arguments,
   and request-key facts;
8. connect call sites to enclosing language symbols;
9. persist partial, dynamic, and ambiguous chains instead of guessing.

One candidate after adapter-specific narrowing is `high`, not `exact`, unless the
transport's dispatch and overload rules are verified. Multiple candidates remain
`ambiguous`.

## 6. ORDS metadata modes

The adapter may consume:

- checked-in ORDS definitions or generated configuration inputs;
- exported deployment metadata;
- live read-only ORDS metadata views/APIs supported by the configured ORDS and
  Oracle versions.

Each adapter declares its supported ORDS versions, metadata source, privilege
requirements, and blind spots. Runtime-generated effective configuration may be
stored as observed deployment evidence, never as the editable source.

## 7. Authorization semantics

Authorization and validation are first-class route facts. The index reports that
a route references a privilege, role, validation function, or policy. It does not
evaluate credentials, infer effective user access, or claim security equivalence
between checked-in and deployed configuration.

Missing authorization metadata lowers coverage; it does not remove the route.

## 8. Dynamic residue

Examples include computed URLs, runtime route registration, dynamic SQL,
data-driven handler selection, synonyms through database links, and generated
configuration. Record:

- source or configuration location;
- unresolved kind and reason;
- known path fragments or candidates;
- evidence source and confidence;
- whether runtime observation could resolve the site.

Development-only runtime evidence begins only after unresolved sites are measured.
Persist names and aggregate counts only. Values and sensitive request data are
discarded before crossing the collector boundary.

## 9. Query behavior

Planned impact queries support inbound and outbound traversal across language
symbols, HTTP endpoints, routes, ORDS handlers, and Oracle symbols. They are:

- generation-bound and cycle-safe;
- depth-, edge-, byte-, and time-limited;
- filterable by edge kind and confidence;
- explicit about unresolved and ambiguous branches;
- accompanied by evidence locators and coverage summaries.

Heuristic edges are excluded by default. Runtime-observed edges are clearly
distinguished from statically complete chains.

## 10. Logical fact model

| Fact | Contents |
| --- | --- |
| Endpoint use | Enclosing source symbol, literal/fragments, HTTP method, argument shape, location |
| Route | Match kind/pattern, exposure class, target, configuration locator |
| ORDS module | Schema context, base path, publication/enablement state |
| ORDS template | Module, path template, parameters |
| ORDS handler | Template, method, source/target kind, routine candidate |
| Authorization fact | Route/handler, privilege/role/validation reference, evidence source |
| Cross-language edge | Typed endpoints such as calls-endpoint, routes-to, handles-with, invokes-routine |
| Unresolved site | Dynamic fragments, candidate targets, reason, source/configuration locator |

Routes and handlers remain distinct from application symbols and Oracle routines.
The graph connects them with evidence-backed edges rather than collapsing names
into one namespace.

## 11. Acceptance gates

- every `exact` chain has complete configuration/dictionary evidence;
- `exact` edges reach at least 95% reviewed precision;
- `high` edges reach at least 90% reviewed precision;
- overload ambiguity is never hidden;
- unresolved ratios are reported per adapter and site kind;
- public/private exposure and authorization metadata survive extraction;
- cross-layer evaluation improves retrieval without correctness loss;
- no persisted event contains request values, credentials, or protected data.
