use std::fs;
use std::time::Instant;

use antlr4_runtime::{
    CommonTokenStream, InputStream, Parser as _, ParserSemCtx, PredictionMode, Token as _,
    TokenSource,
};
use serde::{Deserialize, Serialize};

mod generated {
    pub mod pl_sql_lexer;
    pub mod pl_sql_parser;
}

use generated::pl_sql_lexer::PlSqlLexer;
use generated::pl_sql_parser::{self, PlSqlParser, PlSqlParserHooks};

#[derive(Debug, Deserialize, Serialize)]
struct ManifestFile {
    id: usize,
    path: String,
    file: String,
    bytes: usize,
    lines: usize,
    quantile: f64,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    files: Vec<ManifestFile>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Measurement {
    sll_ms: f64,
    ll_ms: f64,
    total_ms: f64,
    lex_ms: f64,
    parse_ms: f64,
    fallback: bool,
    errors: usize,
    tokens: usize,
    ok: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileResult {
    id: usize,
    path: String,
    bytes: usize,
    lines: usize,
    quantile: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    cold: Option<Measurement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warm: Option<Measurement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    samples_ms: Option<Vec<f64>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    iterations: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warmups: Option<usize>,
    rust_version: String,
    num_cpu: usize,
    max_rss_kb: usize,
    files: Vec<FileResult>,
}

struct Hooks;

impl PlSqlParserHooks for Hooks {
    fn is_not_numeric_function<L>(&mut self, ctx: &mut ParserSemCtx<'_, L>) -> bool
    where
        L: TokenSource,
    {
        let is_numeric = matches!(
            ctx.la(1),
            pl_sql_parser::SUM
                | pl_sql_parser::COUNT
                | pl_sql_parser::AVG
                | pl_sql_parser::MIN
                | pl_sql_parser::MAX
                | pl_sql_parser::ROUND
                | pl_sql_parser::LEAST
                | pl_sql_parser::GREATEST
        );

        !(is_numeric && ctx.la(2) == pl_sql_parser::LEFT_PAREN)
    }

    fn is_not_start_of_join<L>(&mut self, ctx: &mut ParserSemCtx<'_, L>) -> bool
    where
        L: TokenSource,
    {
        !matches!(
            ctx.la(1),
            pl_sql_parser::INNER
                | pl_sql_parser::CROSS
                | pl_sql_parser::NATURAL
                | pl_sql_parser::PARTITION
                | pl_sql_parser::FULL
                | pl_sql_parser::LEFT
                | pl_sql_parser::RIGHT
                | pl_sql_parser::OUTER
        )
    }

    fn is_solidus_separator<L>(&mut self, ctx: &mut ParserSemCtx<'_, L>) -> bool
    where
        L: TokenSource,
    {
        let Some(solidus) = ctx.lt(1) else {
            return false;
        };

        if solidus.token_type() != pl_sql_parser::SOLIDUS {
            return false;
        }

        let line = solidus.line();

        if let Some(previous) = ctx.lt(-1) {
            if previous.token_type() != antlr4_runtime::TOKEN_EOF && previous.line() == line {
                return false;
            }
        }

        if let Some(next) = ctx.lt(2) {
            if next.token_type() != antlr4_runtime::TOKEN_EOF && next.line() == line {
                return false;
            }
        }

        true
    }

    fn is_version10<L>(&mut self, _ctx: &mut ParserSemCtx<'_, L>) -> bool
    where
        L: TokenSource,
    {
        true
    }

    fn is_version11<L>(&mut self, _ctx: &mut ParserSemCtx<'_, L>) -> bool
    where
        L: TokenSource,
    {
        true
    }

    fn is_version12<L>(&mut self, _ctx: &mut ParserSemCtx<'_, L>) -> bool
    where
        L: TokenSource,
    {
        true
    }
}

fn parse_attempt(src: &str, mode: PredictionMode, bail: bool) -> Measurement {
    let input = InputStream::new(src);
    let lexer = PlSqlLexer::new(input);

    let lex_start = Instant::now();
    let tokens = CommonTokenStream::new(lexer);
    let lex_ms = lex_start.elapsed().as_secs_f64() * 1000.0;

    let mut parser = PlSqlParser::with_typed_hooks(tokens, Hooks);
    parser.remove_error_listeners();
    parser.set_prediction_mode(mode);

    if bail {
        parser.set_bail_on_error(true);
    }

    let parse_start = Instant::now();
    let result = parser.sql_script();
    let parse_ms = parse_start.elapsed().as_secs_f64() * 1000.0;
    let errors = parser.number_of_syntax_errors();
    let tokens = parser.token_store().len();

    Measurement {
        sll_ms: if mode == PredictionMode::Sll {
            parse_ms
        } else {
            0.0
        },
        ll_ms: if mode == PredictionMode::Ll {
            parse_ms
        } else {
            0.0
        },
        total_ms: lex_ms + parse_ms,
        lex_ms,
        parse_ms,
        fallback: false,
        errors,
        tokens,
        ok: result.is_ok(),
    }
}

fn parse_once(src: &str, prediction: &str) -> Measurement {
    match prediction {
        "sll" => parse_attempt(src, PredictionMode::Sll, true),
        "sll-first" => {
            let sll = parse_attempt(src, PredictionMode::Sll, true);

            if sll.ok && sll.errors == 0 {
                sll
            } else {
                let mut ll = parse_attempt(src, PredictionMode::Ll, false);
                ll.fallback = true;
                ll.sll_ms = sll.total_ms;
                ll.total_ms += sll.total_ms;
                ll
            }
        }
        _ => parse_attempt(src, PredictionMode::Ll, false),
    }
}

fn max_rss_kb() -> usize {
    let Ok(status) = fs::read_to_string("/proc/self/status") else {
        return 0;
    };

    status
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))
        .and_then(|value| value.split_whitespace().next())
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }

    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let middle = sorted.len() / 2;

    if sorted.len() % 2 == 1 {
        sorted[middle]
    } else {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    }
}

fn option_value<T: std::str::FromStr>(args: &[String], name: &str, default: T) -> T {
    args.iter()
        .position(|argument| argument == name)
        .and_then(|index| args.get(index + 1))
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let manifest_path = option_value(
        &args,
        "--manifest",
        "/bench/corpus/manifest.json".to_owned(),
    );
    let files_root = option_value(&args, "--files", "/bench/corpus/files".to_owned());
    let index: isize = option_value(&args, "--index", -1);
    let warm = args.iter().any(|argument| argument == "--warm");
    let iterations: usize = option_value(&args, "--iterations", 5);
    let warmups: usize = option_value(&args, "--warmups", 1);
    let prediction = option_value(&args, "--prediction", "ll".to_owned());

    let raw = fs::read_to_string(&manifest_path).expect("read manifest");
    let manifest: Manifest = serde_json::from_str(&raw).expect("parse manifest");

    let mut selected = manifest.files;
    if index >= 0 {
        let index = usize::try_from(index).expect("index");
        selected = vec![selected.remove(index)];
    }

    let mut output = Output {
        mode: "cold-single-process".to_owned(),
        iterations: None,
        warmups: None,
        rust_version: std::env::var("RUST_BENCH_VERSION").unwrap_or_else(|_| "unknown".to_owned()),
        num_cpu: std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get),
        max_rss_kb: 0,
        files: Vec::new(),
    };

    if index >= 0 {
        output.mode = "cold-isolated-process".to_owned();
    }

    if warm {
        output.mode = "warm-in-process".to_owned();
        output.iterations = Some(iterations);
        output.warmups = Some(warmups);
    }

    for file in selected {
        let src = fs::read_to_string(std::path::Path::new(&files_root).join(&file.file))
            .expect("read source");
        let mut result = FileResult {
            id: file.id,
            path: file.path,
            bytes: file.bytes,
            lines: file.lines,
            quantile: file.quantile,
            cold: None,
            warm: None,
            samples_ms: None,
        };

        if warm {
            for _ in 0..warmups {
                let _ = parse_once(&src, &prediction);
            }

            let mut samples = Vec::with_capacity(iterations);
            let mut last = None;

            for _ in 0..iterations {
                let measurement = parse_once(&src, &prediction);
                samples.push(measurement.total_ms);
                last = Some(measurement);
            }

            let mut measurement = last.expect("at least one iteration");
            measurement.total_ms = median(&samples);
            result.warm = Some(measurement);
            result.samples_ms = Some(samples);
        } else {
            result.cold = Some(parse_once(&src, &prediction));
        }

        output.files.push(result);
    }

    output.max_rss_kb = max_rss_kb();
    println!(
        "{}",
        serde_json::to_string_pretty(&output).expect("serialize")
    );
}
