/**
 * Coupling and cohesion of the Petra TS port's types, by the type checker
 * (the program of tsconfig.tests.json), for structure.ts to report.
 *
 * - partCohesion: a class with its parts. The units are the class's methods
 *   and the port's functions taking the class as a parameter (the parts split
 *   out of it, `walkTo(plan: AttackPlan, ...)`), linked when they use one
 *   member of the class or one calls the other; `this.x` and `plan.x` alike.
 *   As in structure.ts's class cohesion, hubs (members more than an eighth of
 *   the units use, in classes of 9 units or more) link no group; so do the
 *   whole-state units (using more than half the fields: the saves). LCOM4 is
 *   the number of groups. Each field is listed by the modules that use it,
 *   the constructor and the whole-state units apart: a field only one part's
 *   module uses is state that part could hold.
 * - typeWidth: for each class, interface or object type the port declares,
 *   the members each other port module reads of it, out of its public
 *   instance members. A module using a few members of a wide type could take
 *   an interface of them (as execution/services.ts does for the decision
 *   layer), and a member no other module reads need not be public.
 *
 * Both see through the interfaces a class is given as (implementations):
 * where the port returns, passes or assigns a class's instance as an
 * interface or object type it declares (`get town(): HeadquartersService {
 * return this.HQ; }`), a member read through that type is a read of the
 * class's member of that name too.
 */
import { basename, relative } from "node:path";
import ts from "typescript";

/** The declaration files of the engine and of the common API, the port's only in name */
const FOREIGN_DECLARATIONS = new Set(["common-api.d.ts", "engine-api.d.ts", "globalscripts.d.ts"]);
/** The fewest units a class has for its most used members to count as hubs */
const HUB_MIN_UNITS = 9;
/** A member more units than this share of them use is a hub */
const HUB_SHARE = 8;
/** The fewest fields a class has for its units using most of them to be set apart as whole-state */
const WHOLE_STATE_MIN_FIELDS = 4;
/** A type of fewer public members is never wide */
const WIDE_MIN_MEMBERS = 8;
/** A module using this share of a wide type's members or less uses it narrowly */
const NARROW_SHARE = 4;

export interface PartCohesion
{
	file: string;
	name: string;
	line: number;
	fields: number;
	methods: number;
	/** the functions taking the class, by module */
	parts: Array<{ file: string; functions: string[]; }>;
	units: number;
	/** groups of units linked by the members they share and their calls (hubs and whole-state apart) */
	lcom4: number;
	groups: string[][];
	hubs: string[];
	/** units using more than half the fields */
	whole: string[];
	/** the fields only one module uses (constructor and whole-state units apart), by that module */
	ownedFields: Array<{ file: string; fields: string[]; }>;
}

export interface TypeWidth
{
	file: string;
	name: string;
	line: number;
	/** public instance members */
	members: number;
	/** members another port module reads, directly or through an interface the class is given as */
	usedOutside: number;
	/** the members read through each interface the class is given as */
	through: Array<{ type: string; used: string[]; }>;
	/** the modules reading its members, the narrowest first */
	consumers: Array<{ file: string; used: string[]; }>;
	/** the consumers using a NARROW_SHARE-th of the members or less (a type of WIDE_MIN_MEMBERS members or more) */
	narrow: number;
}

/**
 * Calls `fn` for each member read in `root`, the innermost first: x.name, x["name"] and `const { name } = x`,
 * with the node to report, the member's symbol and the object it is read from.
 */
export function visitMemberAccesses(
	root: ts.Node,
	checker: ts.TypeChecker,
	fn: (node: ts.Node, symbol: ts.Symbol | undefined, object: ts.Node) => void,
): void
{
	const visit = (node: ts.Node): void =>
	{
		ts.forEachChild(node, visit);
		if (ts.isPropertyAccessExpression(node))
		{
			fn(node, checker.getSymbolAtLocation(node.name), node.expression);
		}
		else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
		{
			fn(node, checker.getSymbolAtLocation(node.argumentExpression), node.expression);
		}
		else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && !node.dotDotDotToken)
		{
			const key = node.propertyName ?? node.name;
			const name = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
			const symbol = name === undefined ? undefined : checker.getTypeAtLocation(node.parent).getProperty(name);
			fn(node.name, symbol, node.parent);
		}
	};
	visit(root);
}

/** A port module's path from the port's folder, undefined for the tests and the files outside */
function portModule(port: string, file: string): string | undefined
{
	const rel = relative(port, file).replace(/\\/g, "/");
	return rel.startsWith("..") || rel.startsWith("tests/") || rel.endsWith(".d.ts") ? undefined : rel;
}

function lineOf(node: ts.Node): number
{
	const source = node.getSourceFile();
	return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function isStatic(node: ts.Node): boolean
{
	return ts.canHaveModifiers(node) &&
		(ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
}

function isPublic(node: ts.Node): boolean
{
	return !(ts.canHaveModifiers(node) &&
		(ts.getModifiers(node) ?? []).some((m) =>
			m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword
		)) && !(ts.isClassElement(node) && node.name !== undefined && ts.isPrivateIdentifier(node.name));
}

function nameOf(node: ts.Declaration): string | undefined
{
	const name = ts.getNameOfDeclaration(node);
	return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isPrivateIdentifier(name)) ?
		name.text :
		undefined;
}

/** The symbol a name stands for, past an import's alias */
function resolved(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined
{
	return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Groups of names linked by `links`, the largest first */
function groupsOf(names: string[], links: Array<[string, string]>): string[][]
{
	const parent = new Map(names.map((n) => [n, n]));
	const find = (n: string): string =>
	{
		let root = n;
		while (parent.get(root) !== root)
		{
			root = parent.get(root) ?? root;
		}
		parent.set(n, root);
		return root;
	};
	for (const [a, b] of links)
	{
		parent.set(find(a), find(b));
	}
	const byRoot = new Map<string, string[]>();
	for (const name of names)
	{
		byRoot.set(find(name), [...byRoot.get(find(name)) ?? [], name]);
	}
	return [...byRoot.values()].sort((a, b) => b.length - a.length);
}

interface ClassInfo
{
	node: ts.ClassDeclaration;
	file: string;
	fields: Set<string>;
	/** the instance methods and accessors, by their declarations */
	methods: Map<ts.Node, string>;
	/** each unit's node: the methods' and the functions' taking the class */
	units: Map<ts.Node, { id: string; file: string; }>;
}

/** The port's classes with their fields and methods */
function portClasses(program: ts.Program, port: string): Map<ts.Node, ClassInfo>
{
	const classes = new Map<ts.Node, ClassInfo>();
	for (const source of program.getSourceFiles())
	{
		const file = portModule(port, source.fileName);
		if (file === undefined)
		{
			continue;
		}
		for (const node of source.statements)
		{
			if (!ts.isClassDeclaration(node) || !node.name)
			{
				continue;
			}
			const info: ClassInfo = { node, file, fields: new Set(), methods: new Map(), units: new Map() };
			for (const member of node.members)
			{
				const name = nameOf(member);
				if (name === undefined || isStatic(member))
				{
					continue;
				}
				if (ts.isPropertyDeclaration(member))
				{
					info.fields.add(name);
				}
				else if (ts.isMethodDeclaration(member) || ts.isAccessor(member))
				{
					info.methods.set(member, name);
					info.units.set(member, { id: name, file });
				}
			}
			classes.set(node, info);
		}
	}
	return classes;
}

/** A module's functions, declared or bound to a const, with their names */
function moduleFunctions(source: ts.SourceFile): Array<[string, ts.SignatureDeclaration, ts.Node]>
{
	const found: Array<[string, ts.SignatureDeclaration, ts.Node]> = [];
	for (const node of source.statements)
	{
		if (ts.isFunctionDeclaration(node) && node.name && node.body)
		{
			found.push([node.name.text, node, node]);
		}
		else if (ts.isVariableStatement(node))
		{
			for (const decl of node.declarationList.declarations)
			{
				const init = decl.initializer;
				if (ts.isIdentifier(decl.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)))
				{
					found.push([decl.name.text, init, decl]);
				}
			}
		}
	}
	return found;
}

/** Adds to each class the port's functions taking it as a parameter */
function addParts(program: ts.Program, port: string, classes: Map<ts.Node, ClassInfo>): void
{
	const checker = program.getTypeChecker();
	for (const source of program.getSourceFiles())
	{
		const file = portModule(port, source.fileName);
		if (file === undefined)
		{
			continue;
		}
		for (const [name, fn, decl] of moduleFunctions(source))
		{
			for (const param of fn.parameters)
			{
				const type = checker.getNonNullableType(checker.getTypeAtLocation(param));
				const info = (type.getSymbol()?.declarations ?? []).map((d) => classes.get(d)).find((c) => c);
				if (info && ![...info.units.values()].some((u) => u.id === `${basename(file)}:${name}`))
				{
					info.units.set(decl, { id: `${basename(file)}:${name}`, file });
				}
			}
		}
	}
}

/** Interfaces and object types, each with the port's classes whose instances are given as one of them */
export type Implementations = Map<ts.Node, Set<ts.ClassDeclaration>>;

/** The positions where a value is given as a type: returned, passed, assigned, initialised, set as a property */
function flowsIntoType(node: ts.Node): node is ts.Expression
{
	const parent = node.parent;
	return ts.isExpression(node) &&
		(ts.isReturnStatement(parent) && parent.expression === node ||
			ts.isArrowFunction(parent) && parent.body === node ||
			(ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
				(parent.arguments ?? []).some((a) => a === node) ||
			(ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.initializer === node ||
			ts.isPropertyAssignment(parent) && parent.initializer === node ||
			ts.isShorthandPropertyAssignment(parent) && parent.name === node ||
			ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
				parent.right === node);
}

/**
 * Where the port gives a class's instance as an interface or object type it declares (`get town():
 * HeadquartersService { return this.HQ; }`, a manager passed as a PlacementHQ): a member read through that type
 * is a read of the class's member of that name, wherever the instance is reached through it.
 */
export function implementations(program: ts.Program, port: string): Implementations
{
	const checker = program.getTypeChecker();
	const found: Implementations = new Map();
	const inPort = (decl: ts.Node): boolean =>
	{
		const rel = relative(port, decl.getSourceFile().fileName).replace(/\\/g, "/");
		return !rel.startsWith("..") && !rel.startsWith("tests/") && !FOREIGN_DECLARATIONS.has(rel);
	};
	for (const source of program.getSourceFiles())
	{
		if (portModule(port, source.fileName) === undefined && !source.fileName.endsWith("_petrabot.ts"))
		{
			continue;
		}
		const visit = (node: ts.Node): void =>
		{
			ts.forEachChild(node, visit);
			if (!flowsIntoType(node))
			{
				return;
			}
			const given = checker.getNonNullableType(checker.getTypeAtLocation(node)).getSymbol()?.declarations ?? [];
			const cls = given.find((d): d is ts.ClassDeclaration => ts.isClassDeclaration(d) && inPort(d));
			const target = cls && checker.getContextualType(node);
			if (!cls || !target)
			{
				return;
			}
			const nonNull = checker.getNonNullableType(target);
			const parts = nonNull.isUnionOrIntersection() ? nonNull.types : [nonNull];
			for (const part of parts)
			{
				const aliased = part.aliasSymbol?.declarations?.flatMap((d) =>
					ts.isTypeAliasDeclaration(d) ? [d.type] : []
				) ?? [];
				for (const decl of [...part.getSymbol()?.declarations ?? [], ...aliased])
				{
					if ((ts.isInterfaceDeclaration(decl) || ts.isTypeLiteralNode(decl)) && inPort(decl))
					{
						found.set(decl, (found.get(decl) ?? new Set()).add(cls));
					}
				}
			}
		};
		visit(source);
	}
	return found;
}

/** The classes whose member a symbol names: its own class, or those given as the interface declaring it */
function classesNamed(symbol: ts.Symbol | undefined, impl: Implementations): Array<[ts.Node, string]>
{
	const named: Array<[ts.Node, string]> = [];
	for (const decl of symbol?.declarations ?? [])
	{
		const name = isStatic(decl) ? undefined : nameOf(decl);
		if (name === undefined)
		{
			continue;
		}
		if (ts.isClassDeclaration(decl.parent))
		{
			named.push([decl.parent, name]);
		}
		for (const cls of impl.get(decl.parent) ?? [])
		{
			named.push([cls, name]);
		}
	}
	return named;
}

/** The class member a symbol names, if it is one of `info`'s fields or methods */
function memberOf(symbol: ts.Symbol | undefined, info: ClassInfo, impl: Implementations): string | undefined
{
	const methods = new Set(info.methods.values());
	return classesNamed(symbol, impl).find(([cls, name]) =>
		cls === info.node && (info.fields.has(name) || methods.has(name))
	)?.[1];
}

/** What one unit uses of its class: members, and the other units it names */
function unitUses(
	checker: ts.TypeChecker,
	node: ts.Node,
	info: ClassInfo,
	impl: Implementations,
): { members: Set<string>; units: Set<string>; }
{
	const members = new Set<string>();
	const units = new Set<string>();
	const self = info.units.get(node)?.id;
	visitMemberAccesses(node, checker, (_, symbol) =>
	{
		const member = memberOf(symbol, info, impl);
		if (member !== undefined && member !== self)
		{
			members.add(member);
		}
	});
	const visit = (inner: ts.Node): void =>
	{
		if (ts.isIdentifier(inner))
		{
			for (const decl of resolved(checker, checker.getSymbolAtLocation(inner))?.declarations ?? [])
			{
				const unit = info.units.get(decl);
				if (unit && unit.id !== self && !info.methods.has(decl))
				{
					units.add(unit.id);
				}
			}
		}
		ts.forEachChild(inner, visit);
	};
	visit(node);
	return { members, units };
}

/** Stands for a read in a class's constructor */
const CONSTRUCTOR = "(constructor)";

/** A read of a class's field: the module, and the unit (or the constructor) it is in, undefined in other code */
interface FieldRead
{
	field: string;
	file: string;
	unit: string | undefined;
}

/** Every read of the classes' fields in the port, by class */
function fieldReads(
	program: ts.Program,
	port: string,
	classes: Map<ts.Node, ClassInfo>,
	impl: Implementations,
): Map<ClassInfo, FieldRead[]>
{
	const checker = program.getTypeChecker();
	const reads = new Map<ClassInfo, FieldRead[]>();
	for (const source of program.getSourceFiles())
	{
		const file = portModule(port, source.fileName);
		if (file === undefined)
		{
			continue;
		}
		visitMemberAccesses(source, checker, (node, symbol) =>
		{
			for (const [cls, field] of classesNamed(symbol, impl))
			{
				const info = classes.get(cls);
				if (!info || !info.fields.has(field))
				{
					continue;
				}
				let unit: string | undefined;
				for (let at: ts.Node | undefined = node; at && unit === undefined; at = at.parent)
				{
					unit = ts.isConstructorDeclaration(at) && at.parent === info.node ?
						CONSTRUCTOR :
						info.units.get(at)?.id;
				}
				reads.set(info, [...reads.get(info) ?? [], { field, file, unit }]);
			}
		});
	}
	return reads;
}

/** Each class that has parts, with the cohesion of its methods and parts together */
export function partCohesion(program: ts.Program, port: string): PartCohesion[]
{
	const checker = program.getTypeChecker();
	const classes = portClasses(program, port);
	addParts(program, port, classes);
	const impl = implementations(program, port);
	const reads = fieldReads(program, port, classes, impl);
	const result: PartCohesion[] = [];
	for (const info of classes.values())
	{
		const parts = [...info.units].filter(([node]) => !info.methods.has(node)).map(([, u]) => u);
		if (!parts.length)
		{
			continue;
		}
		// a getter and a setter of one name are one unit
		const uses = new Map<string, { members: Set<string>; units: Set<string>; file: string; }>();
		for (const [node, unit] of info.units)
		{
			const use = unitUses(checker, node, info, impl);
			const known = uses.get(unit.id);
			uses.set(unit.id, {
				members: new Set([...known?.members ?? [], ...use.members]),
				units: new Set([...known?.units ?? [], ...use.units]),
				file: unit.file,
			});
		}
		const usedFields = (id: string): number =>
			[...uses.get(id)?.members ?? []].filter((m) => info.fields.has(m)).length;
		const whole = info.fields.size >= WHOLE_STATE_MIN_FIELDS ?
			[...uses.keys()].filter((id) => usedFields(id) > info.fields.size / 2) :
			[];
		const linking = [...uses].filter(([id]) => !whole.includes(id));
		const userCount = new Map<string, number>();
		for (const [, use] of linking)
		{
			for (const member of use.members)
			{
				userCount.set(member, (userCount.get(member) ?? 0) + 1);
			}
		}
		const hubs = linking.length >= HUB_MIN_UNITS ?
			[...userCount].filter(([, n]) => n > linking.length / HUB_SHARE).map(([m]) => m).sort() :
			[];
		const links: Array<[string, string]> = [];
		const firstUser = new Map<string, string>();
		for (const [id, use] of linking)
		{
			for (const unit of use.units)
			{
				links.push([id, unit]);
			}
			for (const member of [...use.members].filter((m) => !hubs.includes(m)))
			{
				// a method is a unit itself; a field links its users
				if (!info.fields.has(member))
				{
					links.push([id, member]);
				}
				else
				{
					links.push([id, firstUser.get(member) ?? id]);
					firstUser.set(member, firstUser.get(member) ?? id);
				}
			}
		}
		const names = new Set(linking.map(([id]) => id));
		const groups = groupsOf([...names], links.filter(([a, b]) => names.has(a) && names.has(b)));
		// every reader of the port, the constructor and the whole-state units apart
		const fieldModules = new Map<string, Set<string>>();
		for (const read of reads.get(info) ?? [])
		{
			if (read.unit !== CONSTRUCTOR && !(read.unit !== undefined && whole.includes(read.unit)))
			{
				fieldModules.set(read.field, (fieldModules.get(read.field) ?? new Set()).add(read.file));
			}
		}
		const owned = new Map<string, string[]>();
		for (const [field, modules] of fieldModules)
		{
			if (modules.size === 1)
			{
				const [file] = modules;
				owned.set(file, [...owned.get(file) ?? [], field].sort());
			}
		}
		const byModule = new Map<string, string[]>();
		for (const part of parts)
		{
			byModule.set(part.file, [...byModule.get(part.file) ?? [], part.id.slice(part.id.indexOf(":") + 1)]);
		}
		result.push({
			file: info.file,
			name: info.node.name?.text ?? "(anonymous)",
			line: lineOf(info.node),
			fields: info.fields.size,
			methods: info.methods.size,
			parts: [...byModule].map(([file, functions]) => ({ file, functions })).sort((a, b) =>
				a.file.localeCompare(b.file)
			),
			units: info.units.size,
			lcom4: groups.length,
			groups,
			hubs,
			whole,
			ownedFields: [...owned].map(([file, fields]) => ({ file, fields })).sort((a, b) =>
				b.fields.length - a.fields.length || a.file.localeCompare(b.file)
			),
		});
	}
	return result.sort((a, b) => b.units - a.units);
}

interface TypeInfo
{
	file: string;
	name: string;
	line: number;
	members: Set<string>;
	consumers: Map<string, Set<string>>;
	/** members other modules read through an interface it is given as, by that interface */
	through: Map<string, Set<string>>;
}

/** The type a member declaration belongs to (a class, an interface, an aliased object type), with its name */
function ownerOf(decl: ts.Node): [ts.Node, string] | undefined
{
	const parent = decl.parent;
	if ((ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent)) && parent.name)
	{
		return [parent, parent.name.text];
	}
	if (ts.isTypeLiteralNode(parent) && ts.isTypeAliasDeclaration(parent.parent))
	{
		return [parent, parent.parent.name.text];
	}
	return undefined;
}

/** A type's public instance members, all its declarations merged */
function publicMembers(owner: ts.Node): Set<string>
{
	const members = new Set<string>();
	const elements: readonly ts.Node[] =
		ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner) || ts.isTypeLiteralNode(owner) ?
			owner.members :
			[];
	for (const member of elements)
	{
		const name = ts.isClassElement(member) || ts.isTypeElement(member) ? nameOf(member) : undefined;
		if (name !== undefined && !ts.isConstructorDeclaration(member) && !isStatic(member) && isPublic(member))
		{
			members.add(name);
		}
	}
	return members;
}

/** A type's record, made on its first read, with its public members (each declaration of a merged interface adds its own) */
function typeInfo(types: Map<string, TypeInfo>, owner: [ts.Node, string], file: string): TypeInfo
{
	const key = `${file}#${owner[1]}`;
	const type = types.get(key) ??
		{ file, name: owner[1], line: lineOf(owner[0]), members: new Set(), consumers: new Map(), through: new Map() };
	for (const member of publicMembers(owner[0]))
	{
		type.members.add(member);
	}
	types.set(key, type);
	return type;
}

/** For each type the port declares, the members each other module of the port reads of it */
export function typeWidth(program: ts.Program, port: string): TypeWidth[]
{
	const checker = program.getTypeChecker();
	const impl = implementations(program, port);
	const types = new Map<string, TypeInfo>();
	const declaringModule = (decl: ts.Node): string | undefined =>
	{
		const rel = relative(port, decl.getSourceFile().fileName).replace(/\\/g, "/");
		return rel.startsWith("..") || rel.startsWith("tests/") || FOREIGN_DECLARATIONS.has(rel) ? undefined : rel;
	};
	for (const source of program.getSourceFiles())
	{
		const file = portModule(port, source.fileName);
		if (file === undefined)
		{
			continue;
		}
		visitMemberAccesses(source, checker, (_, symbol, object) =>
		{
			if (object.kind === ts.SyntaxKind.ThisKeyword)
			{
				return;
			}
			for (const decl of symbol?.declarations ?? [])
			{
				const owner = ownerOf(decl);
				const declared = owner && declaringModule(decl);
				const name = nameOf(decl);
				if (!owner || declared === undefined || declared === file || name === undefined || isStatic(decl))
				{
					continue;
				}
				const type = typeInfo(types, owner, declared);
				type.consumers.set(file, (type.consumers.get(file) ?? new Set()).add(name));
				// read through an interface: a read of the class given as it, too
				for (const cls of impl.get(owner[0]) ?? [])
				{
					const clsFile = declaringModule(cls);
					if (clsFile !== undefined && clsFile !== file && cls.name && publicMembers(cls).has(name))
					{
						const of = typeInfo(types, [cls, cls.name.text], clsFile);
						of.through.set(owner[1], (of.through.get(owner[1]) ?? new Set()).add(name));
					}
				}
			}
		});
	}
	return [...types.values()].map((t) =>
	{
		const consumers = [...t.consumers].map(([file, used]) => ({ file, used: [...used].sort() })).sort((a, b) =>
			a.used.length - b.used.length || a.file.localeCompare(b.file)
		);
		const wide = t.members.size >= WIDE_MIN_MEMBERS;
		return {
			file: t.file,
			name: t.name,
			line: t.line,
			members: t.members.size,
			usedOutside: new Set([
				...consumers.flatMap((c) => c.used),
				...[...t.through.values()].flatMap((u) => [...u]),
			]).size,
			through: [...t.through].map(([type, used]) => ({ type, used: [...used].sort() })).sort((a, b) =>
				a.type.localeCompare(b.type)
			),
			consumers,
			narrow: wide ? consumers.filter((c) => c.used.length * NARROW_SHARE <= t.members.size).length : 0,
		};
	}).sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));
}
