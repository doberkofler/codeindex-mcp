FROM golang:1.23.12-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends default-jre-headless curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /bench

COPY grammar/PlSqlLexer.g4 grammar/PlSqlParser.g4 /bench/grammar/
COPY PlSqlLexerBase.go PlSqlParserBase.go /bench/parser/
COPY corpus/manifest.json /bench/corpus/manifest.json
COPY corpus/files /bench/corpus/files
COPY main.go /bench/main.go
COPY go.mod /bench/go.mod

RUN curl -fsSL https://www.antlr.org/download/antlr-4.13.1-complete.jar -o /opt/antlr.jar \
    && java -jar /opt/antlr.jar -Dlanguage=Go -package parser -visitor -no-listener \
        -Xexact-output-dir -o /bench/parser \
        /bench/grammar/PlSqlLexer.g4 /bench/grammar/PlSqlParser.g4 \
    && go mod tidy \
    && go build -trimpath -ldflags='-s -w' -o /bench/bench .

ENTRYPOINT ["/bench/bench"]
