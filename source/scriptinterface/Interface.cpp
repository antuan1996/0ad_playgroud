/* Copyright (C) 2026 Wildfire Games.
 * This file is part of 0 A.D.
 *
 * 0 A.D. is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * 0 A.D. is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with 0 A.D.  If not, see <http://www.gnu.org/licenses/>.
 */

#include "precompiled.h"

#include "Interface.h"

#include "lib/debug.h"
#include "lib/file/vfs/vfs_path.h"
#include "lib/file/vfs/vfs_util.h"
#include "lib/utf8.h"
#include "ps/CLogger.h"
#include "ps/CStr.h"
#include "ps/Filesystem.h"
#include "ps/MatchTimes.h"
#include "ps/Profile.h"
#include "ps/Profiler2.h"
#include "ps/ThreadUtil.h"
#include "scriptinterface/FunctionWrapper.h"
#include "scriptinterface/ModuleLoader.h"
#include "scriptinterface/Object.h"
#include "scriptinterface/Context.h"
#include "scriptinterface/Stats.h"
#include "scriptinterface/StructuredClone.h"

#include <cstdio>
#include <cstring>
#include <js/CallAndConstruct.h>
#include <js/Class.h>
#include <js/ComparisonOperators.h>
#include <js/CompilationAndEvaluation.h>
#include <js/CompileOptions.h>
#include <js/GCVector.h>
#include <js/GlobalObject.h>
#include <js/PropertyAndElement.h>
#include <js/PropertyDescriptor.h>
#include <js/Realm.h>
#include <js/RealmOptions.h>
#include <js/SourceText.h>
#include <jsapi.h>
#include <mozilla/Maybe.h>
#include <string>
#include <vector>

namespace JS { class Compartment; }
namespace mozilla { union Utf8Unit; }

#define BOOST_MULTI_INDEX_DISABLE_SERIALIZATION
#include <boost/preprocessor/punctuation/comma_if.hpp>
#include <boost/preprocessor/repetition/repeat.hpp>
#include <boost/random/linear_congruential.hpp>
#include <boost/flyweight.hpp>
#include <boost/flyweight/key_value.hpp>
#include <boost/flyweight/no_locking.hpp>
#include <boost/flyweight/no_tracking.hpp>

/**
 * @file
 * Abstractions of various SpiderMonkey features.
 * Engine code should be using functions of these interfaces rather than
 * directly accessing the underlying JS api.
 */

namespace Script
{

struct Interface_impl
{
	Interface_impl(const char* nativeScopeName, Context& context,
		JS::Compartment* compartment, std::function<bool(const VfsPath&)> allowModule);
	~Interface_impl();

	// Take care to keep this declaration before heap rooted members. Destructors of heap rooted
	// members have to be called before the context destructor.
	Context& m_context;

	friend Request;
	private:
		JSContext* m_cx;
		JS::PersistentRootedObject m_glob; // global scope object

	public:
		boost::rand48* m_rng;
		JS::PersistentRootedObject m_nativeScope; // native function scope object
	ModuleLoader m_ModuleLoader;
};

/**
 * Constructor for Request - here because it needs access into Interface_impl.
 */
Request::Request(const Interface& scriptInterface) :
	cx(scriptInterface.m->m_cx),
	glob(scriptInterface.m->m_glob),
	nativeScope(scriptInterface.m->m_nativeScope),
	m_ScriptInterface(scriptInterface)
{
	m_FormerRealm = JS::EnterRealm(cx, scriptInterface.m->m_glob);
}

Request::~Request()
{
	JS::LeaveRealm(cx, m_FormerRealm);
}

Request::Request(JSContext* cx) : Request(Interface::CmptPrivate::GetScriptInterface(cx))
{
}

JS::Value Request::globalValue() const
{
	return JS::ObjectValue(*glob);
}

const Interface& Request::GetScriptInterface() const
{
	return m_ScriptInterface;
}

} // namespace Script

namespace
{

JSClassOps global_classops = {
	nullptr, nullptr,
	nullptr, nullptr,
	nullptr, nullptr, nullptr,
	nullptr, nullptr,
	JS_GlobalObjectTraceHook
};

JSClass global_class = {
	"global", JSCLASS_GLOBAL_FLAGS, &global_classops
};

// Functions in the global namespace:

bool print(JSContext* cx, unsigned int argc, JS::Value* vp)
{
	JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
	Script::Request rq(cx);

	for (unsigned int i = 0; i < args.length(); ++i)
	{
		std::wstring str;
		if (!Script::FromJSVal(rq, args[i], str))
			return false;
		debug_printf("%s", utf8_from_wstring(str).c_str());
	}
	fflush(stdout);
	args.rval().setUndefined();
	return true;
}

bool logmsg(JSContext* cx, unsigned int argc, JS::Value* vp)
{
	JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
	if (args.length() < 1)
	{
		args.rval().setUndefined();
		return true;
	}

	Script::Request rq(cx);
	std::wstring str;
	if (!Script::FromJSVal(rq, args[0], str))
		return false;
	LOGMESSAGE("{}", utf8_from_wstring(str));
	args.rval().setUndefined();
	return true;
}

bool warn(JSContext* cx, unsigned int argc, JS::Value* vp)
{
	JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
	if (args.length() < 1)
	{
		args.rval().setUndefined();
		return true;
	}

	Script::Request rq(cx);
	std::wstring str;
	if (!Script::FromJSVal(rq, args[0], str))
		return false;
	LOGWARNING("{}", utf8_from_wstring(str));
	args.rval().setUndefined();
	return true;
}

bool error(JSContext* cx, unsigned int argc, JS::Value* vp)
{
	JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
	if (args.length() < 1)
	{
		args.rval().setUndefined();
		return true;
	}

	Script::Request rq(cx);
	std::wstring str;
	if (!Script::FromJSVal(rq, args[0], str))
		return false;
	LOGERROR("{}", utf8_from_wstring(str));
	args.rval().setUndefined();
	return true;
}

JS::Value deepcopy(const Script::Request& rq, JS::HandleValue val)
{
	if (val.isNullOrUndefined())
	{
		Script::Exception::Raise(rq, "deepcopy requires one argument.");
		return JS::UndefinedValue();
	}

	JS::RootedValue ret(rq.cx, Script::DeepCopy(rq, val));
	if (ret.isNullOrUndefined())
	{
		Script::Exception::Raise(rq, "deepcopy StructureClone copy failed.");
		return JS::UndefinedValue();
	}
	return ret;
}

JS::Value deepfreeze(const Script::Interface& scriptInterface, JS::HandleValue val)
{
	Script::Request rq(scriptInterface);
	if (!val.isObject())
	{
		Script::Exception::Raise(rq, "deepfreeze requires exactly one object as an argument.");
		return JS::UndefinedValue();
	}

	Script::DeepFreezeObject(rq, val);
	return val;
}

void ProfileStart(const std::string& regionName)
{
	const char* name = "(ProfileStart)";

	typedef boost::flyweight<
		std::string,
		boost::flyweights::no_tracking,
		boost::flyweights::no_locking
	> StringFlyweight;

	if (!regionName.empty())
		name = StringFlyweight(regionName).get().c_str();

	if (CProfileManager::IsInitialised() && Threading::IsMainThread())
		g_Profiler.StartScript(name);

	g_Profiler2.RecordRegionEnter(name);

	if (MatchTimes::Enabled() && Threading::IsMainThread())
		MatchTimes::RegionEnter(name);
}

void ProfileStop()
{
	if (CProfileManager::IsInitialised() && Threading::IsMainThread())
		g_Profiler.Stop();

	g_Profiler2.RecordRegionLeave();

	if (MatchTimes::Enabled() && Threading::IsMainThread())
		MatchTimes::RegionLeave();
}

void ProfileAttribute(const std::string& attr)
{
	const char* name = "(ProfileAttribute)";

	typedef boost::flyweight<
		std::string,
		boost::flyweights::no_tracking,
		boost::flyweights::no_locking
	> StringFlyweight;

	if (!attr.empty())
		name = StringFlyweight(attr).get().c_str();

	g_Profiler2.RecordAttribute("%s", name);
}

// Math override functions:

// boost::uniform_real is apparently buggy in Boost pre-1.47 - for integer generators
// it returns [min,max], not [min,max). The bug was fixed in 1.47.
// We need consistent behaviour, so manually implement the correct version:
static double generate_uniform_real(boost::rand48& rng, double min, double max)
{
	while (true)
	{
		double n = (double)(rng() - rng.min());
		double d = (double)(rng.max() - rng.min()) + 1.0;
		ENSURE(d > 0 && n >= 0 && n <= d);
		double r = n / d * (max - min) + min;
		if (r < max)
			return r;
	}
}

} // anonymous namespace

namespace Script
{

bool Interface::MathRandom(double& nbr) const
{
	if (m->m_rng == nullptr)
		return false;
	nbr = generate_uniform_real(*(m->m_rng), 0.0, 1.0);
	return true;
}

bool Interface::Math_random(JSContext* cx, unsigned int argc, JS::Value* vp)
{
	JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
	double r;
	if (!Interface::CmptPrivate::GetScriptInterface(cx).MathRandom(r))
		return false;

	args.rval().setNumber(r);
	return true;
}

Interface_impl::Interface_impl(const char* nativeScopeName, Context& context,
	JS::Compartment* compartment, std::function<bool(const VfsPath&)> allowModule) :
	m_context(context), m_cx(context.GetGeneralJSContext()), m_glob(context.GetGeneralJSContext()),
	m_nativeScope(context.GetGeneralJSContext()),
	m_ModuleLoader{std::move(allowModule)}
{
	JS::RealmCreationOptions creationOpt;
	// Keep JIT code during non-shrinking GCs. This brings a quite big performance improvement.
	creationOpt.setPreserveJitCode(true);
	// Enable uneval
	creationOpt.setToSourceEnabled(true);

	if (compartment)
		creationOpt.setExistingCompartment(compartment);
	else
		// This is the default behaviour.
		creationOpt.setNewCompartmentAndZone();

	JS::RealmOptions opt(creationOpt, JS::RealmBehaviors{});

	m_glob = JS_NewGlobalObject(m_cx, &global_class, nullptr, JS::OnNewGlobalHookOption::FireOnNewGlobalHook, opt);

	JSAutoRealm autoRealm(m_cx, m_glob);

	ENSURE(JS::InitRealmStandardClasses(m_cx));

	JS_DefineProperty(m_cx, m_glob, "global", m_glob, JSPROP_ENUMERATE | JSPROP_READONLY | JSPROP_PERMANENT);

	// These first 4 actually use CallArgs & thus don't use Script::Function
	JS_DefineFunction(m_cx, m_glob, "print", ::print,        0, JSPROP_ENUMERATE | JSPROP_READONLY | JSPROP_PERMANENT);
	JS_DefineFunction(m_cx, m_glob, "log",   ::logmsg,       1, JSPROP_ENUMERATE | JSPROP_READONLY | JSPROP_PERMANENT);
	JS_DefineFunction(m_cx, m_glob, "warn",  ::warn,         1, JSPROP_ENUMERATE | JSPROP_READONLY | JSPROP_PERMANENT);
	JS_DefineFunction(m_cx, m_glob, "error", ::error,        1, JSPROP_ENUMERATE | JSPROP_READONLY | JSPROP_PERMANENT);
	Script::Function::Register<deepcopy>(m_cx, m_glob, "clone");
	Script::Function::Register<deepfreeze>(m_cx, m_glob, "deepfreeze");

	m_nativeScope = JS_DefineObject(m_cx, m_glob, nativeScopeName, nullptr, JSPROP_ENUMERATE | JSPROP_READONLY | JSPROP_PERMANENT);

	Script::Function::Register<&ProfileStart>(m_cx, m_nativeScope, "ProfileStart");
	Script::Function::Register<&ProfileStop>(m_cx, m_nativeScope, "ProfileStop");
	Script::Function::Register<&ProfileAttribute>(m_cx, m_nativeScope, "ProfileAttribute");

	m_context.RegisterRealm(JS::GetObjectRealmOrNull(m_glob));
}

Interface_impl::~Interface_impl()
{
	m_context.UnRegisterRealm(JS::GetObjectRealmOrNull(m_glob));
}

Interface::Interface(const char* nativeScopeName, const char* debugName, Context& context,
	std::function<bool(const VfsPath&)> allowModule) :
	m{std::make_unique<Interface_impl>(nativeScopeName, context, nullptr,
		std::move(allowModule))}
{
	// Profiler stats table isn't thread-safe, so only enable this on the main thread
	if (Threading::IsMainThread())
	{
		if (g_ScriptStatsTable)
			g_ScriptStatsTable->Add(this, debugName);
	}

	Request rq(this);
	m_CmptPrivate.pScriptInterface = this;
	JS::SetRealmPrivate(JS::GetObjectRealmOrNull(rq.glob), (void*)&m_CmptPrivate);
}

Interface::Interface(const char* nativeScopeName, const char* debugName,
	const Interface& neighbor, std::function<bool(const VfsPath& path)> allowModule)
{
	Request nrq(neighbor);
	JS::Compartment* comp = JS::GetCompartmentForRealm(JS::GetCurrentRealmOrNull(nrq.cx));
	m = std::make_unique<Interface_impl>(nativeScopeName, neighbor.GetContext(), comp,
		std::move(allowModule));

	// Profiler stats table isn't thread-safe, so only enable this on the main thread
	if (Threading::IsMainThread())
	{
		if (g_ScriptStatsTable)
			g_ScriptStatsTable->Add(this, debugName);
	}

	Request rq(this);
	m_CmptPrivate.pScriptInterface = this;
	JS::SetRealmPrivate(JS::GetObjectRealmOrNull(rq.glob), (void*)&m_CmptPrivate);
}

Interface::~Interface()
{
	m->m_context.RunJobs();
	if (Threading::IsMainThread())
	{
		if (g_ScriptStatsTable)
			g_ScriptStatsTable->Remove(this);
	}
}

const Interface& Interface::CmptPrivate::GetScriptInterface(JSContext *cx)
{
	CmptPrivate* pCmptPrivate = (CmptPrivate*)JS::GetRealmPrivate(JS::GetCurrentRealmOrNull(cx));
	ENSURE(pCmptPrivate);
	return *pCmptPrivate->pScriptInterface;
}

void* Interface::CmptPrivate::GetCBData(JSContext *cx)
{
	CmptPrivate* pCmptPrivate = (CmptPrivate*)JS::GetRealmPrivate(JS::GetCurrentRealmOrNull(cx));
	return pCmptPrivate ? pCmptPrivate->pCBData : nullptr;
}

void Interface::SetCallbackData(void* pCBData)
{
	m_CmptPrivate.pCBData = pCBData;
}

template <>
void* Interface::ObjectFromCBData<void>(const Request& rq)
{
	return Interface::CmptPrivate::GetCBData(rq.cx);
}

bool Interface::LoadGlobalScripts()
{
	// Ignore this failure in tests
	if (!g_VFS)
		return false;

	// Load and execute *.js in the global scripts directory
	VfsPaths pathnames;
	vfs::GetPathnames(g_VFS, L"globalscripts/", L"*.js", pathnames);
	for (const VfsPath& path : pathnames)
		if (!LoadGlobalScriptFile(path))
		{
			LOGERROR("LoadGlobalScripts: Failed to load script {}", path.string8());
			return false;
		}

	return true;
}

bool Interface::ReplaceNondeterministicRNG(boost::rand48& rng)
{
	Request rq(this);
	JS::RootedValue math(rq.cx);
	JS::RootedObject global(rq.cx, rq.glob);
	if (JS_GetProperty(rq.cx, global, "Math", &math) && math.isObject())
	{
		JS::RootedObject mathObj(rq.cx, &math.toObject());
		JS::RootedFunction random(rq.cx, JS_DefineFunction(rq.cx, mathObj, "random", Math_random, 0,
			JSPROP_ENUMERATE | JSPROP_READONLY | JSPROP_PERMANENT));
		if (random)
		{
			m->m_rng = &rng;
			return true;
		}
	}

	Exception::CatchPending(rq);
	LOGERROR("ReplaceNondeterministicRNG: failed to replace Math.random");
	return false;
}

JSContext* Interface::GetGeneralJSContext() const
{
	return m->m_context.GetGeneralJSContext();
}

Context& Interface::GetContext() const
{
	return m->m_context;
}

ModuleLoader& Interface::GetModuleLoader() const
{
	return m->m_ModuleLoader;
}

void Interface::CallConstructor(JS::HandleValue ctor, JS::HandleValueArray argv, JS::MutableHandleValue out) const
{
	Request rq(this);
	if (!ctor.isObject())
	{
		LOGERROR("CallConstructor: ctor is not an object");
		out.setNull();
		return;
	}

	JS::RootedObject objOut(rq.cx);
	if (!JS::Construct(rq.cx, ctor, argv, &objOut))
		out.setNull();
	else
		out.setObjectOrNull(objOut);
}

void Interface::DefineCustomObjectType(JSClass *clasp, JSNative constructor, unsigned int minArgs,
	JSPropertySpec *ps, JSFunctionSpec *fs, JSPropertySpec *static_ps, JSFunctionSpec *static_fs)
{
	Request rq(this);
	std::string typeName = clasp->name;

	if (m_CustomObjectTypes.find(typeName) != m_CustomObjectTypes.end())
	{
		// This type already exists
		throw PSERROR_Scripting_DefineType_AlreadyExists();
	}

	JS::RootedObject global(rq.cx, rq.glob);
	JS::RootedObject obj(rq.cx, JS_InitClass(rq.cx, global,
	                                           clasp, nullptr, clasp->name,
	                                           constructor, minArgs,     // Constructor, min args
	                                           ps, fs,                   // Properties, methods
	                                           static_ps, static_fs));   // Constructor properties, methods

	if (obj == nullptr)
	{
		Exception::CatchPending(rq);
		throw PSERROR_Scripting_DefineType_CreationFailed();
	}

	CustomType& type = m_CustomObjectTypes[typeName];

	type.m_Prototype.init(rq.cx, obj);
	type.m_Class = clasp;
	type.m_Constructor = constructor;
}

JSObject* Interface::CreateCustomObject(const std::string& typeName) const
{
	std::unordered_map<std::string, CustomType>::const_iterator it = m_CustomObjectTypes.find(typeName);

	if (it == m_CustomObjectTypes.end())
		throw PSERROR_Scripting_TypeDoesNotExist();

	Request rq(this);
	JS::RootedObject prototype(rq.cx, it->second.m_Prototype.get());
	return JS_NewObjectWithGivenProto(rq.cx, it->second.m_Class, prototype);
}

bool Interface::SetGlobal_(const char* name, JS::HandleValue value, bool replace, bool constant, bool enumerate)
{
	Request rq(this);
	JS::RootedObject global(rq.cx, rq.glob);

	bool found;
	if (!JS_HasProperty(rq.cx, global, name, &found))
		return false;
	if (found)
	{
		JS::Rooted<mozilla::Maybe<JS::PropertyDescriptor>> desc(rq.cx);
		if (!JS_GetOwnPropertyDescriptor(rq.cx, global, name, &desc) || !desc.isSome())
			return false;

		if (!desc->writable())
		{
			if (!replace)
			{
				Exception::Raise(rq, "SetGlobal \"%s\" called multiple times", name);
				return false;
			}

			// This is not supposed to happen, unless the user has called SetProperty with constant = true on the global object
			// instead of using SetGlobal.
			if (!desc->configurable())
			{
				Exception::Raise(rq, "The global \"%s\" is permanent and cannot be hotloaded", name);
				return false;
			}

			LOGMESSAGE("Hotloading new value for global \"{}\".", name);
			ENSURE(JS_DeleteProperty(rq.cx, global, name));
		}
	}

	unsigned int attrs = 0;
	if (constant)
		attrs |= JSPROP_READONLY;
	if (enumerate)
		attrs |= JSPROP_ENUMERATE;

	return JS_DefineProperty(rq.cx, global, name, value, attrs);
}

bool Interface::GetGlobalProperty(const Request& rq, const std::string& name, JS::MutableHandleValue out)
{
	// Try to get the object as a property of the global object.
	JS::RootedObject global(rq.cx, rq.glob);
	if (!JS_GetProperty(rq.cx, global, name.c_str(), out))
	{
		out.set(JS::NullHandleValue);
		return false;
	}

	if (!out.isNullOrUndefined())
		return true;

	// Some objects, such as const definitions, or Class definitions, are hidden inside closures.
	// We must fetch those from the correct lexical scope.
	//JS::RootedValue glob(cx);
	JS::RootedObject lexical_environment(rq.cx, JS_GlobalLexicalEnvironment(rq.glob));
	if (!JS_GetProperty(rq.cx, lexical_environment, name.c_str(), out))
	{
		out.set(JS::NullHandleValue);
		return false;
	}

	if (!out.isNullOrUndefined())
		return true;

	out.set(JS::NullHandleValue);
	return false;
}

bool Interface::SetPrototype(JS::HandleValue objVal, JS::HandleValue protoVal)
{
	Request rq(this);
	if (!objVal.isObject() || !protoVal.isObject())
		return false;
	JS::RootedObject obj(rq.cx, &objVal.toObject());
	JS::RootedObject proto(rq.cx, &protoVal.toObject());
	return JS_SetPrototype(rq.cx, obj, proto);
}

bool Interface::LoadScript(const VfsPath& filename, const std::string& code) const
{
	Request rq(this);
	JS::RootedObject global(rq.cx, rq.glob);

	// CompileOptions does not copy the contents of the filename string pointer.
	// Passing a temporary string there will cause undefined behaviour, so we create a separate string to avoid the temporary.
	std::string filenameStr = filename.string8();

	JS::CompileOptions options(rq.cx);
	// Set the line to 0 because CompileFunction silently adds a `(function() {` as the first line,
	// and errors get misreported.
	// TODO: it would probably be better to not implicitly introduce JS scopes.
	options.setFileAndLine(filenameStr.c_str(), 0);
	options.setIsRunOnce(false);
	options.setForceStrictMode();

	JS::SourceText<mozilla::Utf8Unit> src;
	ENSURE(src.init(rq.cx, code.c_str(), code.length(), JS::SourceOwnership::Borrowed));
	JS::RootedObjectVector emptyScopeChain(rq.cx);
	JS::RootedFunction func(rq.cx, JS::CompileFunction(rq.cx, emptyScopeChain, options, NULL, 0, NULL, src));
	if (func == nullptr)
	{
		Exception::CatchPending(rq);
		return false;
	}

	JS::RootedValue rval(rq.cx);
	if (JS_CallFunction(rq.cx, nullptr, func, JS::HandleValueArray::empty(), &rval))
		return true;

	Exception::CatchPending(rq);
	return false;
}

bool Interface::LoadGlobalScript(const VfsPath& filename, const std::string& code) const
{
	Request rq(this);
	// CompileOptions does not copy the contents of the filename string pointer.
	// Passing a temporary string there will cause undefined behaviour, so we create a separate string to avoid the temporary.
	std::string filenameStr = filename.string8();

	JS::RootedValue rval(rq.cx);
	JS::CompileOptions opts(rq.cx);
	opts.setFileAndLine(filenameStr.c_str(), 1);
	opts.setForceStrictMode();

	JS::SourceText<mozilla::Utf8Unit> src;
	ENSURE(src.init(rq.cx, code.c_str(), code.length(), JS::SourceOwnership::Borrowed));
	if (JS::Evaluate(rq.cx, opts, src, &rval))
		return true;

	Exception::CatchPending(rq);
	return false;
}

bool Interface::LoadGlobalScriptFile(const VfsPath& path) const
{
	if (!VfsFileExists(path))
	{
		LOGERROR("File '{}' does not exist", path.string8());
		return false;
	}

	CVFSFile file;

	PSRETURN ret = file.Load(g_VFS, path);

	if (ret != PSRETURN_OK)
	{
		LOGERROR("Failed to load file '{}': {}", path.string8(), GetErrorString(ret));
		return false;
	}

	CStr code = file.DecodeUTF8(); // assume it's UTF-8

	return LoadGlobalScript(path, code);
}

bool Interface::Eval(const std::string_view code) const
{
	Request rq(this);
	JS::RootedValue rval(rq.cx);

	JS::CompileOptions opts(rq.cx);
	opts.setFileAndLine("(eval)", 1);
	opts.setForceStrictMode();
	JS::SourceText<mozilla::Utf8Unit> src;
	ENSURE(src.init(rq.cx, code.data(), code.size(), JS::SourceOwnership::Borrowed));
	if (JS::Evaluate(rq.cx, opts, src, &rval))
		return true;

	Exception::CatchPending(rq);
	return false;
}

bool Interface::Eval(const std::string_view code, JS::MutableHandleValue rval) const
{
	Request rq(this);

	JS::CompileOptions opts(rq.cx);
	opts.setFileAndLine("(eval)", 1);
	opts.setForceStrictMode();
	JS::SourceText<mozilla::Utf8Unit> src;
	ENSURE(src.init(rq.cx, code.data(), code.size(), JS::SourceOwnership::Borrowed));
	if (JS::Evaluate(rq.cx, opts, src, rval))
		return true;

	Exception::CatchPending(rq);
	return false;
}

} // namespace Script
