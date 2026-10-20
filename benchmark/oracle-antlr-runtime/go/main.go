package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/antlr4-go/antlr/v4"
	"oraclegoantlrbench/parser"
)

type manifestFile struct {
	ID       int     `json:"id"`
	Path     string  `json:"path"`
	File     string  `json:"file"`
	Bytes    int     `json:"bytes"`
	Lines    int     `json:"lines"`
	Quantile float64 `json:"quantile"`
}

type manifest struct {
	Files []manifestFile `json:"files"`
}

type countingListener struct {
	*antlr.DefaultErrorListener
	count int
}

func (l *countingListener) SyntaxError(_ antlr.Recognizer, _ interface{}, _, _ int, _ string, _ antlr.RecognitionException) {
	l.count++
}

type parseMeasurement struct {
	SLLMs     float64 `json:"sllMs"`
	LLMs      float64 `json:"llMs"`
	TotalMs   float64 `json:"totalMs"`
	Fallback  bool    `json:"fallback"`
	Errors    int     `json:"errors"`
	Tokens    int     `json:"tokens"`
	Bailed    bool    `json:"bailed"`
	PanicText string  `json:"panic,omitempty"`
}

type fileResult struct {
	ID       int               `json:"id"`
	Path     string            `json:"path"`
	Bytes    int               `json:"bytes"`
	Lines    int               `json:"lines"`
	Quantile float64           `json:"quantile"`
	Cold     *parseMeasurement `json:"cold,omitempty"`
	Warm     *parseMeasurement `json:"warm,omitempty"`
	Samples  []float64         `json:"samplesMs,omitempty"`
}

type output struct {
	Mode       string       `json:"mode"`
	Iterations int          `json:"iterations,omitempty"`
	Warmups    int          `json:"warmups,omitempty"`
	GoVersion  string       `json:"goVersion"`
	NumCPU     int          `json:"numCpu"`
	MaxRSSKB   int          `json:"maxRssKb"`
	Files      []fileResult `json:"files"`
}

func parseAttempt(src string, sll bool) (m parseMeasurement) {
	var listener *countingListener
	defer func() {
		if r := recover(); r != nil {
			m.Bailed = true
			m.PanicText = fmt.Sprint(r)
		}
	}()

	input := antlr.NewInputStream(src)
	lexer := parser.NewPlSqlLexer(input)
	lexer.RemoveErrorListeners()
	stream := antlr.NewCommonTokenStream(lexer, antlr.TokenDefaultChannel)
	p := parser.NewPlSqlParser(stream)
	p.RemoveErrorListeners()
	listener = &countingListener{DefaultErrorListener: antlr.NewDefaultErrorListener()}
	p.AddErrorListener(listener)

	if sll {
		p.GetInterpreter().SetPredictionMode(antlr.PredictionModeSLL)
		p.SetErrorHandler(antlr.NewBailErrorStrategy())
	} else {
		p.GetInterpreter().SetPredictionMode(antlr.PredictionModeLL)
	}

	start := time.Now()
	p.Sql_script()
	m.TotalMs = float64(time.Since(start).Microseconds()) / 1000
	m.Tokens = stream.Size()
	if list := listener; list != nil {
		m.Errors = list.count
	}
	return m
}

func parseOnce(src string) parseMeasurement {
	sll := parseAttempt(src, true)
	if sll.Bailed || sll.Errors > 0 {
		ll := parseAttempt(src, false)
		ll.Fallback = true
		ll.SLLMs = sll.TotalMs
		ll.LLMs = ll.TotalMs
		ll.TotalMs += sll.SLLMs
		ll.Bailed = sll.Bailed
		ll.PanicText = sll.PanicText
		return ll
	}

	sll.SLLMs = sll.TotalMs
	return sll
}

func maxRSSKB() int {
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "VmHWM:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				n, _ := strconv.Atoi(fields[1])
				return n
			}
		}
	}
	return 0
}

func median(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	copyValues := append([]float64(nil), values...)
	sort.Float64s(copyValues)
	mid := len(copyValues) / 2
	if len(copyValues)%2 == 1 {
		return copyValues[mid]
	}
	return (copyValues[mid-1] + copyValues[mid]) / 2
}

func main() {
	manifestPath := flag.String("manifest", "/bench/corpus/manifest.json", "manifest file")
	fileRoot := flag.String("files", "/bench/corpus/files", "sample file root")
	index := flag.Int("index", -1, "parse only this manifest index")
	warm := flag.Bool("warm", false, "warm repeated run")
	iterations := flag.Int("iterations", 5, "warm iterations")
	warmups := flag.Int("warmups", 1, "warm warmups")
	flag.Parse()

	raw, err := os.ReadFile(*manifestPath)
	if err != nil {
		panic(err)
	}
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		panic(err)
	}

	out := output{
		Mode:      "cold-single-process",
		GoVersion: runtime.Version(),
		NumCPU:    runtime.NumCPU(),
	}

	selected := m.Files
	if *index >= 0 {
		if *index >= len(selected) {
			panic("index out of range")
		}
		selected = selected[*index : *index+1]
		out.Mode = "cold-isolated-process"
	}
	if *warm {
		out.Mode = "warm-in-process"
		out.Iterations = *iterations
		out.Warmups = *warmups
	}

	for _, f := range selected {
		srcBytes, err := os.ReadFile(filepath.Join(*fileRoot, f.File))
		if err != nil {
			panic(err)
		}
		src := string(srcBytes)
		result := fileResult{ID: f.ID, Path: f.Path, Bytes: f.Bytes, Lines: f.Lines, Quantile: f.Quantile}

		if *warm {
			for i := 0; i < *warmups; i++ {
				_ = parseOnce(src)
			}
			samples := make([]float64, 0, *iterations)
			var last parseMeasurement
			for i := 0; i < *iterations; i++ {
				last = parseOnce(src)
				samples = append(samples, last.TotalMs)
			}
			last.TotalMs = median(samples)
			result.Warm = &last
			result.Samples = samples
		} else {
			measurement := parseOnce(src)
			result.Cold = &measurement
		}
		out.Files = append(out.Files, result)
	}

	out.MaxRSSKB = maxRSSKB()
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(out); err != nil {
		panic(err)
	}
}
