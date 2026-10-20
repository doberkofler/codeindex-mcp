from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
marker = "antlr4_runtime::__antlr4_rust_parser_facade! {"
method = """impl<L, H> PlSqlParser<L, H>
where
    L: antlr4_runtime::TokenSource,
    H: antlr4_runtime::SemanticHooks,
{
    /// Exposes the runtime bail strategy through the generated parser facade.
    pub fn set_bail_on_error(&mut self, bail: bool) {
        self.base.set_bail_on_error(bail);
    }
}

"""

if "pub fn set_bail_on_error(&mut self" not in source:
    if marker not in source:
        raise SystemExit(f"generated parser facade marker not found in {path}")
    source = source.replace(marker, method + marker, 1)

path.write_text(source)
