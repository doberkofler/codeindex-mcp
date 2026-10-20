FROM rust:1.95-bookworm AS builder

RUN cargo install antlr-rust-codegen --version 0.34.0 --locked --bin antlr4-rust-gen

WORKDIR /bench

COPY grammar /bench/grammar
COPY patch-generated.py /bench/patch-generated.py

RUN antlr4-rust-gen \
        /bench/grammar/PlSqlLexer.g4 \
        /bench/grammar/PlSqlParser.g4 \
        --lib /bench/grammar \
        --out-dir /bench/src/generated \
        --no-listener \
        --no-visitor \
    && python3 /bench/patch-generated.py /bench/src/generated/pl_sql_parser.rs

COPY Cargo.toml Cargo.lock /bench/
COPY src/main.rs /bench/src/main.rs

ENV ANTLR4_RUST_GENERATED_ONLY=1
ENV RUST_BENCH_VERSION=1.95.0

RUN cargo build --release --locked

FROM debian:bookworm-slim

WORKDIR /bench

COPY --from=builder /bench/target/release/rustantlrbench /bench/bench
COPY corpus /bench/corpus

ENTRYPOINT ["/bench/bench"]
