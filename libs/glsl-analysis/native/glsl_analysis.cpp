// Shadergrove ESSL analysis wrapper around the pinned glslang front end.
//
// The wrapper validates one prepared ESSL 100/300 source per call with
// glslang's GLSL front end in validation mode: no client, no target, no SPIR-V
// or Vulkan rules. It serialises owned values only (info logs, effective
// version/profile, declared globals and user-function signatures) as JSON; no
// AST node or native pointer escapes. Every TShader/TProgram is scoped to one
// call and destroyed before returning, which releases its pool allocator.
//
// Upstream sources live untouched under .tmp/glsl-analysis/src (see
// third_party/glslang/UPSTREAM.json); this file is Shadergrove code.

#include <malloc.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <vector>

#include <emscripten/emscripten.h>

#include "glslang/Public/ResourceLimits.h"
#include "glslang/Public/ShaderLang.h"
#include "glslang/MachineIndependent/localintermediate.h"
#include "glslang/build_info.h"

#ifndef GLA_GLSLANG_COMMIT
#error "GLA_GLSLANG_COMMIT must name the pinned glslang commit"
#endif

namespace {

// Bounded so a pathological source cannot produce an unbounded reply.
constexpr int kMaxGlobals = 1024;
constexpr int kMaxFunctions = 1024;
constexpr int kMaxMemberDepth = 4;

class Json {
public:
    void raw(const char* text) { out_ += text; }
    void raw(char c) { out_ += c; }
    void number(long long value) { out_ += std::to_string(value); }
    void boolean(bool value) { out_ += value ? "true" : "false"; }
    void string(const char* text) { string(text, std::strlen(text)); }
    void string(const std::string& text) { string(text.data(), text.size()); }
    void string(const char* text, size_t length)
    {
        out_ += '"';
        for (size_t i = 0; i < length; ++i) {
            const unsigned char c = static_cast<unsigned char>(text[i]);
            switch (c) {
            case '"': out_ += "\\\""; break;
            case '\\': out_ += "\\\\"; break;
            case '\n': out_ += "\\n"; break;
            case '\r': out_ += "\\r"; break;
            case '\t': out_ += "\\t"; break;
            default:
                if (c < 0x20) {
                    char escaped[8];
                    std::snprintf(escaped, sizeof escaped, "\\u%04x", c);
                    out_ += escaped;
                } else {
                    out_ += static_cast<char>(c);
                }
            }
        }
        out_ += '"';
    }
    void key(const char* name)
    {
        string(name);
        out_ += ':';
    }
    char* release() const
    {
        char* copy = static_cast<char*>(std::malloc(out_.size() + 1));
        if (copy)
            std::memcpy(copy, out_.c_str(), out_.size() + 1);
        return copy;
    }

private:
    std::string out_;
};

const char* profileName(EProfile profile)
{
    switch (profile) {
    case EEsProfile: return "es";
    case ECoreProfile: return "core";
    case ECompatibilityProfile: return "compatibility";
    default: return "none";
    }
}

const char* precisionName(glslang::TPrecisionQualifier precision)
{
    switch (precision) {
    case glslang::EpqLow: return "lowp";
    case glslang::EpqMedium: return "mediump";
    case glslang::EpqHigh: return "highp";
    default: return nullptr;
    }
}

const char* storageName(glslang::TStorageQualifier storage)
{
    switch (storage) {
    case glslang::EvqUniform: return "uniform";
    case glslang::EvqVaryingIn: return "in";
    case glslang::EvqVaryingOut: return "out";
    case glslang::EvqGlobal: return "global";
    case glslang::EvqConst: return "const";
    case glslang::EvqIn: return "in";
    case glslang::EvqOut: return "out";
    case glslang::EvqInOut: return "inout";
    case glslang::EvqConstReadOnly: return "const in";
    case glslang::EvqTemporary: return "temporary";
    default: return glslang::GetStorageQualifierString(storage);
    }
}

// GLSL spelling of the unqualified, unsized type (e.g. "vec3", "mat2x3", "sampler2D").
std::string baseTypeText(const glslang::TType& type)
{
    using namespace glslang;
    if (type.getBasicType() == EbtSampler)
        return type.getSampler().getString();
    if (type.isStruct())
        return type.getTypeName().c_str();
    std::string prefix;
    switch (type.getBasicType()) {
    case EbtInt: prefix = "i"; break;
    case EbtUint: prefix = "u"; break;
    case EbtBool: prefix = "b"; break;
    case EbtDouble: prefix = "d"; break;
    default: break;
    }
    if (type.isMatrix()) {
        const int cols = type.getMatrixCols();
        const int rows = type.getMatrixRows();
        return prefix + "mat" + std::to_string(cols) +
               (cols == rows ? std::string() : "x" + std::to_string(rows));
    }
    if (type.isVector())
        return prefix + "vec" + std::to_string(type.getVectorSize());
    return type.getBasicTypeString().c_str();
}

void writeArraySizes(Json& json, const glslang::TType& type)
{
    json.raw('[');
    if (type.isArray()) {
        const glslang::TArraySizes* sizes = type.getArraySizes();
        for (int i = 0; i < sizes->getNumDims(); ++i) {
            if (i)
                json.raw(',');
            const int size = sizes->getDimSize(i);
            if (size == glslang::UnsizedArraySize)
                json.raw("null");
            else
                json.number(size);
        }
    }
    json.raw(']');
}

std::string typeText(const glslang::TType& type)
{
    std::string text;
    if (const char* precision = precisionName(type.getQualifier().precision)) {
        text += precision;
        text += ' ';
    }
    text += baseTypeText(type);
    if (type.isArray()) {
        const glslang::TArraySizes* sizes = type.getArraySizes();
        for (int i = 0; i < sizes->getNumDims(); ++i) {
            const int size = sizes->getDimSize(i);
            text += size == glslang::UnsizedArraySize ? std::string("[]")
                                                      : "[" + std::to_string(size) + "]";
        }
    }
    return text;
}

void writeType(Json& json, const glslang::TType& type, int depth)
{
    json.raw('{');
    json.key("text");
    json.string(typeText(type));
    json.raw(',');
    json.key("base");
    json.string(baseTypeText(type));
    json.raw(',');
    json.key("precision");
    if (const char* precision = precisionName(type.getQualifier().precision))
        json.string(precision);
    else
        json.raw("null");
    json.raw(',');
    json.key("arraySizes");
    writeArraySizes(json, type);
    if (type.isStruct() && type.getStruct() && depth < kMaxMemberDepth) {
        json.raw(',');
        json.key("members");
        json.raw('[');
        bool first = true;
        for (const glslang::TTypeLoc& member : *type.getStruct()) {
            if (member.type->hiddenMember())
                continue;
            if (!first)
                json.raw(',');
            first = false;
            json.raw('{');
            json.key("name");
            json.string(member.type->getFieldName().c_str());
            json.raw(',');
            json.key("type");
            writeType(json, *member.type, depth + 1);
            json.raw('}');
        }
        json.raw(']');
    }
    json.raw('}');
}

void writeLocation(Json& json, const glslang::TSourceLoc& loc)
{
    if (loc.line <= 0) {
        json.raw("null");
        return;
    }
    json.raw('{');
    json.key("string");
    json.string(loc.getStringNameOrNum(false));
    json.raw(',');
    json.key("line");
    json.number(loc.line);
    json.raw(',');
    json.key("column");
    json.number(loc.column);
    json.raw('}');
}

bool isBuiltInName(const glslang::TString& name)
{
    return name.compare(0, 3, "gl_") == 0;
}

void writeGlobal(Json& json, const glslang::TIntermSymbol& symbol)
{
    const glslang::TType& type = symbol.getType();
    const glslang::TQualifier& qualifier = type.getQualifier();
    json.raw('{');
    json.key("name");
    json.string(symbol.getName().c_str());
    json.raw(',');
    json.key("storage");
    json.string(storageName(qualifier.storage));
    json.raw(',');
    json.key("block");
    json.boolean(type.getBasicType() == glslang::EbtBlock);
    json.raw(',');
    json.key("anonymous");
    json.boolean(symbol.getName().compare(0, 5, "anon@") == 0);
    json.raw(',');
    json.key("layoutLocation");
    if (qualifier.hasLocation())
        json.number(qualifier.layoutLocation);
    else
        json.raw("null");
    json.raw(',');
    json.key("invariant");
    json.boolean(qualifier.invariant);
    json.raw(',');
    json.key("type");
    writeType(json, type, 0);
    json.raw('}');
}

void writeFunction(Json& json, glslang::TIntermAggregate& function)
{
    const glslang::TString& mangled = function.getName();
    const size_t paren = mangled.find('(');
    json.raw('{');
    json.key("name");
    json.string(std::string(mangled.c_str(), paren == glslang::TString::npos ? mangled.size() : paren));
    json.raw(',');
    json.key("mangledName");
    json.string(mangled.c_str());
    json.raw(',');
    json.key("returnType");
    writeType(json, function.getType(), 0);
    json.raw(',');
    json.key("parameters");
    json.raw('[');
    glslang::TIntermSequence& children = function.getSequence();
    glslang::TIntermAggregate* parameters =
        children.empty() ? nullptr : children[0]->getAsAggregate();
    if (parameters && parameters->getOp() == glslang::EOpParameters) {
        bool first = true;
        for (TIntermNode* node : parameters->getSequence()) {
            const glslang::TIntermSymbol* parameter = node->getAsSymbolNode();
            if (!parameter)
                continue;
            if (!first)
                json.raw(',');
            first = false;
            json.raw('{');
            json.key("name");
            if (parameter->getName().empty())
                json.raw("null");
            else
                json.string(parameter->getName().c_str());
            json.raw(',');
            json.key("qualifier");
            json.string(storageName(parameter->getType().getQualifier().storage));
            json.raw(',');
            json.key("type");
            writeType(json, parameter->getType(), 0);
            json.raw('}');
        }
    }
    json.raw(']');
    json.raw(',');
    json.key("location");
    writeLocation(json, function.getLoc());
    json.raw('}');
}

// Top-level declarations only: function definitions and the linker-object list.
// Locals, prototypes without bodies and struct-only declarations are not part of
// this list by design (see the package README).
void writeSymbols(Json& json, glslang::TIntermediate& intermediate)
{
    glslang::TIntermAggregate* root =
        intermediate.getTreeRoot() ? intermediate.getTreeRoot()->getAsAggregate() : nullptr;
    int globals = 0;
    int functions = 0;
    bool truncated = false;

    json.key("globals");
    json.raw('[');
    if (root) {
        for (TIntermNode* node : root->getSequence()) {
            glslang::TIntermAggregate* aggregate = node->getAsAggregate();
            if (!aggregate || aggregate->getOp() != glslang::EOpLinkerObjects)
                continue;
            for (TIntermNode* object : aggregate->getSequence()) {
                const glslang::TIntermSymbol* symbol = object->getAsSymbolNode();
                if (!symbol || symbol->getType().isBuiltIn() || isBuiltInName(symbol->getName()))
                    continue;
                if (globals == kMaxGlobals) {
                    truncated = true;
                    break;
                }
                if (globals++)
                    json.raw(',');
                writeGlobal(json, *symbol);
            }
        }
    }
    json.raw("],");

    json.key("functions");
    json.raw('[');
    if (root) {
        for (TIntermNode* node : root->getSequence()) {
            glslang::TIntermAggregate* aggregate = node->getAsAggregate();
            if (!aggregate || aggregate->getOp() != glslang::EOpFunction)
                continue;
            if (functions == kMaxFunctions) {
                truncated = true;
                break;
            }
            if (functions++)
                json.raw(',');
            writeFunction(json, *aggregate);
        }
    }
    json.raw("],");
    json.key("symbolsTruncated");
    json.boolean(truncated);
}

// ---------------------------------------------------------------------------
// Opt-in observation catalogue (gla_observe only; ordinary analysis never runs
// this). Walks the semantic tree for statement-level `local = expr;` nodes whose
// target is a directly declared float/vec2/vec3/vec4 local, and reports the
// compiler's view: symbol id, effective type/precision, a source-location HINT
// and control context. Nothing here proves an editable span; the TypeScript
// verifier re-derives and checks every point against the exact prepared source.

constexpr int kMaxObservationPoints = 128;
constexpr int kMaxObservationRefusals = 128;

struct ObsContext {
    int loopDepth = 0;
    int conditionalDepth = 0;
    bool header = false;
};

struct ObsPoint {
    std::string function;
    std::string name;
    long long symbolId = 0;
    std::string base;
    const char* precision = nullptr;
    int line = 0;
    int column = 0;
    ObsContext context;
};

struct ObsRefusal {
    const char* reason;
    int line;
    int column;
};

class ObservationWalker {
public:
    void walkFunction(glslang::TIntermAggregate& function)
    {
        const glslang::TString& mangled = function.getName();
        const size_t paren = mangled.find('(');
        function_ = std::string(mangled.c_str(), paren == glslang::TString::npos ? mangled.size() : paren);
        names_.clear();
        pending_.clear();
        for (TIntermNode* child : function.getSequence())
            walk(child, false, ObsContext());
        for (ObsPoint& point : pending_) {
            const bool ambiguous = names_[point.name].size() > 1;
            if (static_cast<int>(points_.size()) == kMaxObservationPoints) {
                pointsTruncated_ = true;
                continue;
            }
            points_.push_back(point);
            ambiguous_.push_back(ambiguous);
        }
    }

    void write(Json& json) const
    {
        json.key("observation");
        json.raw('{');
        json.key("points");
        json.raw('[');
        for (size_t i = 0; i < points_.size(); ++i) {
            const ObsPoint& point = points_[i];
            if (i)
                json.raw(',');
            json.raw('{');
            json.key("function");
            json.string(point.function);
            json.raw(',');
            json.key("name");
            json.string(point.name);
            json.raw(',');
            json.key("symbolId");
            json.number(point.symbolId);
            json.raw(',');
            json.key("base");
            json.string(point.base);
            json.raw(',');
            json.key("precision");
            if (point.precision)
                json.string(point.precision);
            else
                json.raw("null");
            json.raw(',');
            json.key("line");
            json.number(point.line);
            json.raw(',');
            json.key("column");
            json.number(point.column);
            json.raw(',');
            json.key("loopDepth");
            json.number(point.context.loopDepth);
            json.raw(',');
            json.key("conditionalDepth");
            json.number(point.context.conditionalDepth);
            json.raw(',');
            json.key("header");
            json.boolean(point.context.header);
            json.raw(',');
            json.key("ambiguousName");
            json.boolean(ambiguous_[i]);
            json.raw('}');
        }
        json.raw("],");
        json.key("refusals");
        json.raw('[');
        for (size_t i = 0; i < refusals_.size(); ++i) {
            if (i)
                json.raw(',');
            json.raw('{');
            json.key("reason");
            json.string(refusals_[i].reason);
            json.raw(',');
            json.key("line");
            json.number(refusals_[i].line);
            json.raw(',');
            json.key("column");
            json.number(refusals_[i].column);
            json.raw('}');
        }
        json.raw("],");
        json.key("pointsTruncated");
        json.boolean(pointsTruncated_);
        json.raw(',');
        json.key("refusalsTruncated");
        json.boolean(refusalsTruncated_);
        json.raw('}');
    }

private:
    void refuse(const char* reason, const glslang::TSourceLoc& loc)
    {
        if (static_cast<int>(refusals_.size()) == kMaxObservationRefusals) {
            refusalsTruncated_ = true;
            return;
        }
        refusals_.push_back({reason, loc.line, loc.column});
    }

    void consider(glslang::TIntermBinary& binary, const ObsContext& context)
    {
        const glslang::TOperator op = binary.getOp();
        if (op != glslang::EOpAssign) {
            if (binary.modifiesState())
                refuse("compound-assignment", binary.getLoc());
            return;
        }
        const glslang::TIntermSymbol* target = binary.getLeft()->getAsSymbolNode();
        if (!target) {
            refuse("lvalue", binary.getLoc());
            return;
        }
        const glslang::TType& type = target->getType();
        const bool floatFamily = type.getBasicType() == glslang::EbtFloat && !type.isArray() &&
                                 !type.isMatrix() && !type.isStruct() &&
                                 (type.isScalar() || type.isVector());
        if (!floatFamily) {
            refuse("type", binary.getLoc());
            return;
        }
        if (type.getQualifier().storage != glslang::EvqTemporary) {
            refuse("storage", binary.getLoc());
            return;
        }
        const char* precision = precisionName(type.getQualifier().precision);
        if (!precision) {
            refuse("precision", binary.getLoc());
            return;
        }
        ObsPoint point;
        point.function = function_;
        point.name = target->getName().c_str();
        // glslang tags ids above 2^53; the low 32 bits are the per-compile counter.
        point.symbolId = target->getId() & 0xffffffffLL;
        point.base = baseTypeText(type);
        point.precision = precision;
        point.line = binary.getLoc().line;
        point.column = binary.getLoc().column;
        point.context = context;
        pending_.push_back(point);
    }

    // A control arm without braces is a bare expression node, never a point: an
    // assignment is refused explicitly; other state changes keep their own reasons.
    void walkArm(TIntermNode* node, const ObsContext& context)
    {
        glslang::TIntermBinary* binary = node ? node->getAsBinaryNode() : nullptr;
        if (binary && binary->getOp() == glslang::EOpAssign) {
            refuse("unbraced", binary->getLoc());
            walk(node, false, context);
            return;
        }
        walk(node, true, context);
    }

    void walk(TIntermNode* node, bool statement, const ObsContext& context)
    {
        if (!node)
            return;
        if (glslang::TIntermVariableDecl* declaration = node->getAsVariableDecl()) {
            walk(declaration->getInitNode(), statement, context);
            return;
        }
        if (glslang::TIntermAggregate* aggregate = node->getAsAggregate()) {
            const bool sequence = aggregate->getOp() == glslang::EOpSequence;
            for (TIntermNode* child : aggregate->getSequence())
                walk(child, sequence, context);
            return;
        }
        if (glslang::TIntermBinary* binary = node->getAsBinaryNode()) {
            if (statement)
                consider(*binary, context);
            walk(binary->getLeft(), false, context);
            walk(binary->getRight(), false, context);
            return;
        }
        if (glslang::TIntermUnary* unary = node->getAsUnaryNode()) {
            if (statement && unary->modifiesState())
                refuse("increment", unary->getLoc());
            walk(unary->getOperand(), false, context);
            return;
        }
        if (glslang::TIntermSelection* selection = node->getAsSelectionNode()) {
            ObsContext branch = context;
            ++branch.conditionalDepth;
            walk(selection->getCondition(), false, context);
            walkArm(selection->getTrueBlock(), branch);
            walkArm(selection->getFalseBlock(), branch);
            return;
        }
        if (glslang::TIntermLoop* loop = node->getAsLoopNode()) {
            ObsContext body = context;
            ++body.loopDepth;
            ++body.conditionalDepth;
            ObsContext header = body;
            header.header = true;
            walkArm(loop->getBody(), body);
            walk(loop->getTest(), false, header);
            walk(loop->getTerminal(), false, header);
            return;
        }
        if (glslang::TIntermSwitch* choice = node->getAsSwitchNode()) {
            ObsContext body = context;
            ++body.conditionalDepth;
            walk(choice->getCondition(), false, context);
            walk(choice->getBody(), false, body);
            return;
        }
        if (glslang::TIntermBranch* branch = node->getAsBranchNode()) {
            walk(branch->getExpression(), false, context);
            return;
        }
        if (const glslang::TIntermSymbol* symbol = node->getAsSymbolNode())
            names_[symbol->getName().c_str()].insert(symbol->getId());
    }

    std::string function_;
    std::map<std::string, std::set<long long>> names_;
    std::vector<ObsPoint> pending_;
    std::vector<ObsPoint> points_;
    std::vector<bool> ambiguous_;
    std::vector<ObsRefusal> refusals_;
    bool pointsTruncated_ = false;
    bool refusalsTruncated_ = false;
};

void writeObservation(Json& json, glslang::TIntermediate& intermediate)
{
    ObservationWalker walker;
    glslang::TIntermAggregate* root =
        intermediate.getTreeRoot() ? intermediate.getTreeRoot()->getAsAggregate() : nullptr;
    if (root) {
        for (TIntermNode* node : root->getSequence()) {
            glslang::TIntermAggregate* aggregate = node->getAsAggregate();
            if (aggregate && aggregate->getOp() == glslang::EOpFunction)
                walker.walkFunction(*aggregate);
        }
    }
    walker.write(json);
}

// stage: 0 = vertex, 1 = fragment. `observe` appends the opt-in catalogue.
char* analyzeSource(const char* source, int length, int stage, bool observe)
{
    const EShLanguage language = stage == 0 ? EShLangVertex : EShLangFragment;
    // Validation mode: errors plus columns, never SPIR-V or Vulkan rules.
    const EShMessages messages =
        static_cast<EShMessages>(EShMsgDefault | EShMsgDisplayErrorColumn);
    Json json;
    json.raw('{');
    {
        glslang::TShader shader(language);
        const char* strings[] = {source};
        const int lengths[] = {length};
        shader.setStringsWithLengths(strings, lengths, 1);
        shader.setEnvInput(glslang::EShSourceGlsl, language, glslang::EShClientNone, 0);
        shader.setEnvClient(glslang::EShClientNone, static_cast<glslang::EShTargetClientVersion>(0));
        shader.setEnvTarget(glslang::EShTargetNone, static_cast<glslang::EShTargetLanguageVersion>(0));

        // A source without #version is ESSL 1.00, as WebGL treats it.
        const bool parsed =
            shader.parse(GetDefaultResources(), 100, EEsProfile, false, false, messages);
        glslang::TIntermediate* intermediate = shader.getIntermediate();

        json.key("parsed");
        json.boolean(parsed);
        json.raw(',');
        json.key("version");
        json.number(intermediate ? intermediate->getVersion() : 0);
        json.raw(',');
        json.key("profile");
        json.string(intermediate ? profileName(intermediate->getProfile()) : "none");
        json.raw(',');
        json.key("infoLog");
        json.string(shader.getInfoLog());
        json.raw(',');

        bool linked = false;
        if (parsed && intermediate) {
            // Collected before linking: link-time checks prune uncalled functions.
            writeSymbols(json, *intermediate);
            json.raw(',');
            if (observe) {
                writeObservation(json, *intermediate);
                json.raw(',');
            }
            glslang::TProgram program;  // destroyed before `shader`, as required
            program.addShader(&shader);
            linked = program.link(messages);
            json.key("linkLog");
            json.string(program.getInfoLog());
            json.raw(',');
        }
        json.key("linked");
        json.boolean(linked);
    }
    json.raw('}');
    return json.release();
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE char* gla_init()
{
    const bool initialized = glslang::InitializeProcess();
    Json json;
    json.raw('{');
    json.key("initialized");
    json.boolean(initialized);
    json.raw(',');
    json.key("glslangVersion");
    json.string(std::to_string(GLSLANG_VERSION_MAJOR) + "." + std::to_string(GLSLANG_VERSION_MINOR) +
                "." + std::to_string(GLSLANG_VERSION_PATCH) + GLSLANG_VERSION_FLAVOR);
    json.raw(',');
    json.key("glslangCommit");
    json.string(GLA_GLSLANG_COMMIT);
    json.raw('}');
    return json.release();
}

// stage: 0 = vertex, 1 = fragment. `source` is UTF-8 of `length` bytes.
// Returns a malloc'd JSON document that the caller frees with gla_free, or
// null if the reply itself could not be allocated.
EMSCRIPTEN_KEEPALIVE char* gla_analyze(const char* source, int length, int stage)
{
    return analyzeSource(source, length, stage, false);
}

// Same contract as gla_analyze plus the opt-in observation catalogue.
EMSCRIPTEN_KEEPALIVE char* gla_observe(const char* source, int length, int stage)
{
    return analyzeSource(source, length, stage, true);
}

EMSCRIPTEN_KEEPALIVE void gla_free(char* reply)
{
    std::free(reply);
}

// Bytes currently allocated by malloc; used by tests to prove per-request cleanup.
EMSCRIPTEN_KEEPALIVE int gla_heap_used()
{
    return static_cast<int>(mallinfo().uordblks);
}

}  // extern "C"
