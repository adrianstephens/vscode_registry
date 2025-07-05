#include "base.h"
#include "text.h"
#include "string.h"

#include <windows.h>
#include <io.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

//static auto& out = std::wcout;

struct WinFile {
	HANDLE	h;
	WinFile(HANDLE h) : h(h) {}
	~WinFile() { CloseHandle(h); }
	explicit operator bool() const { return h != INVALID_HANDLE_VALUE; }
};

struct WinFileWriter : WinFile {
	WinFileWriter(const wchar_t *filename) : WinFile(CreateFile(filename, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL)) {}
	~WinFileWriter() {
		FlushFileBuffers(h);
	}
	size_t writebuff(const void *p, size_t n) {
		DWORD	written;
		WriteFile(h, p, n, &written, NULL);
		return written;
	}
};

struct WinFileReader : WinFile {
	WinFileReader(const wchar_t *filename) : WinFile(CreateFile(filename, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL)) {}
	int readbuff(void *p, size_t n) {
		DWORD	read;
		if (!ReadFile(h, p, n, &read, NULL))
			return -1;
		return read;
	}
};

struct FileWriter : TextWriter<wchar_t> {
	FILE	*h;
	int		column;

	FileWriter(FILE *h) : h(h) {}
	FileWriter(const wchar_t *filename) {
		_wfopen_s(&h, filename, L"w, ccs=UTF-8");
	}
	~FileWriter() { fflush(h); fclose(h); }
	operator FILE*() const { return h; }

	size_t write(const wchar_t* buffer, size_t size) {
		auto n = fwrite(buffer, sizeof(wchar_t), size, h);
		column += n;
		return n;
	}
	void flush() { fflush(h); column = 0;}
};

struct FileReader {
	FILE	*h;
	FileReader(FILE *h) : h(h) {}
	FileReader(const wchar_t *filename) {
		if (_wfopen_s(&h, filename, L"r") == 0) {
			auto b0 = ::getc(h);
			if (b0 == 0xef) {
				if (::getc(h) == 0xbb && ::getc(h) == 0xbf) {
					_wfreopen_s(&h, filename, L"r, ccs=UTF-8", h);
					return;
				}
			} else if (b0 == 0xff) {
				if (::getc(h) == 0xfe) {
					_wfreopen_s(&h, filename, L"r, ccs=UTF-16LE", h);
					return;
				}
			} else if (b0 == 0xfe) {
				if (::getc(h) == 0xff) {
					_wfreopen_s(&h, filename, L"r, ccs=UTF-16BE", h);
					return;
				}
			}
			fseek(h, 0, SEEK_SET);
		}
	}
	~FileReader() { if (h) fclose(h); }
	operator FILE*() const { return h; }
/*
	int readbuff(void* buffer, size_t size) {
		return fread(buffer, 1, size, h);
	}
	template<typename T> bool get(T &t) {
		return readbuff(&t, sizeof(T)) == sizeof(T);
	}
*/
	int getc() const {
		auto c = fgetwc(h);
        return c == WEOF ? -1 : c;
	}
    bool eof() const {
        return feof(h);
    }

};

FileWriter	out(stdout);

void waitDebugger() {
	bool forever = true;
	while (forever) {
		out << L"waiting for attach..." << endl;
		Sleep(1000);
	}
}

//-----------------------------------------------------------------------------
// base
//-----------------------------------------------------------------------------

template<typename T, int B, int N, char TEN> struct _base {
	T t;
	constexpr _base(T t = 0) : t(t) {}
	constexpr operator T() const { return t; }
	template<typename C> friend void put(TextWriter<C>& p, const _base& h) {
		C temp[N];
		p.write(put_digits<B>(h.t, end(temp), TEN, N), N);
	}
};

template<typename T, int B, char TEN> struct _base<T, B, -1, TEN> {
	T t;
	constexpr _base(T t = 0) : t(t) {}
	constexpr operator T() const { return t; }
	template<typename C> friend void put(TextWriter<C>& w, const _base& h) {
		C temp[sizeof(T) * 8];	// max digits if binary
		auto p = put_digits<B>(h.t, end(temp), TEN);
		w.write(p, end(temp) - p);
	}
};

template<int B, int N = -1, char TEN = 'a', typename T> auto base(T t) {
	return _base<T, B, N, TEN>(t);
}


//-----------------------------------------------------------------------------
//	helpers
//-----------------------------------------------------------------------------

bool wildcard_check(const wchar_t* line, const wchar_t* pattern, bool anchored = false) {
	const wchar_t* placeholder = anchored ? nullptr : pattern;

	while (*line && *pattern) {
		auto c = *pattern++;
		if (c == '?' || c == *line)
			line++;
		else if (c == '*')
			placeholder = pattern;
		else if (--pattern == placeholder)
			line++;
		else if (placeholder)
			pattern = placeholder;
		else
			return false;
	}

	return !*pattern && (!anchored || !*line);
}

auto unescape(string::view v, wchar_t *dest, wchar_t separator = 0) {
	auto p = dest;
	for (auto s = v.begin(), e = v.end(); s < e;) {
		auto c = *s++;
		if (c == '\\' && s[0]) {
			switch (c = *s++) {
				case '\\': break;
				case '"': break;
				case '0': c = '\0'; break;
				case 'n': c = '\n'; break;
				case 'r': c = '\r'; break;
				case 't': c = '\t'; break;
				default: *p++ = '\\'; break;
			}
		}
		if (c == separator)
			c = 0;
		*p++ = c;
	}
	*p = 0;
	return p - dest;
}

auto escape(string::view v, wchar_t *dest, wchar_t separator = 0) {
	auto p = dest;
	for (auto s = v.begin(), e = v.end(); s < e;) {
		auto c = *s++;
		switch (c) {
			case '\\': *p++ = '\\'; break;
			case '"':  *p++ = '\\'; break;
			case '\0': *p++ = '\\'; c = '0'; break;
			case '\n': *p++ = '\\'; c = 'n'; break;
			case '\r': *p++ = '\\'; c = 'r'; break;
			case '\t': *p++ = '\\'; c = 't'; break;
			default:
				if (c == separator) {
					*p++ = '\\';
					c = '0';
				}
				break;
		}
		*p++ = c;
	}
	*p = 0;
	return p - dest;
}
/*
const char *hex = "0123456789abcdef";
*/

auto hexchar(wchar_t c) {
	return c >= '0' && c <= '9' ? c - '0'
		: c >= 'A' && c <= 'F' ? c - 'A' + 10
		: c >= 'a' && c <= 'f' ? c - 'a' + 10
		: -1;
}
//-----------------------------------------------------------------------------
//	registry stuff
//-----------------------------------------------------------------------------

#define MAX_KEY_LENGTH 255
#define MAX_VALUE_NAME 16383

enum class OP : uint8_t {
	QUERY,
	ADD,
	DEL,
	EXPORT,
	IMPORT,
	/* COPY, SAVE, RESTORE,*/
	LOAD,
	UNLOAD,
	/* COMPARE, FLAGS*/
	NUM
};
static const wchar_t* ops[] = {
	L"QUERY",
	L"ADD",
	L"DELETE",
	L"EXPORT",
	L"IMPORT",
//	L"COPY",
//	L"SAVE",
//	L"RESTORE",
	L"LOAD",
	L"UNLOAD",
//	L"COMPARE",
//	L"FLAGS"
};
OP get_op(const wchar_t *op) {
	for (auto& i : ops) {
		if (_wcsicmp(op, i) == 0) {
			return OP(&i - &ops[0]);
		}
	}
	return OP::NUM;
}

enum class TYPE : uint8_t {
	NONE,
	SZ,
	EXPAND_SZ,
	BINARY,
	DWORD,
	DWORD_BIG_ENDIAN,
	LINK,
	MULTI_SZ,
	RESOURCE_LIST,
	FULL_RESOURCE_DESCRIPTOR,
	RESOURCE_REQUIREMENTS_LIST,
	QWORD,
	NUM,
};
static const wchar_t* types[] = {
	L"REG_NONE",
	L"REG_SZ",
	L"REG_EXPAND_SZ",
	L"REG_BINARY",
	L"REG_DWORD",	// aka REG_DWORD_LITTLE_ENDIAN
	L"REG_DWORD_BIG_ENDIAN",
	L"REG_LINK",
	L"REG_MULTI_SZ",
	L"REG_RESOURCE_LIST",
	L"REG_FULL_RESOURCE_DESCRIPTOR",
	L"REG_RESOURCE_REQUIREMENTS_LIST",
	L"REG_QWORD",	// aka REG_QWORD_LITTLE_ENDIAN
};
TYPE get_type(const wchar_t *type) {
	if (!type)
		return TYPE::SZ;
	for (auto &t : types) {
		if (wcscmp(type, t) == 0)
			return TYPE(&t - types);
	}
	return TYPE::NUM;
}

enum class HIVE : uint8_t {
	HKCR,
	HKCU,
	HKLM,
	HKU,
	HKPD,
	HKCC,
	NUM,
};
const wchar_t *hives[][2] = {
	L"HKEY_CLASSES_ROOT",		L"HKCR",
	L"HKEY_CURRENT_USER",		L"HKCU",
	L"HKEY_LOCAL_MACHINE",		L"HKLM",
	L"HKEY_USERS",				L"HKU",
	L"HKEY_PERFORMANCE_DATA",	L"HKPD",
	L"HKEY_CURRENT_CONFIG",		L"HKCC",
};

HIVE get_hive(const string &hive) {
	for (auto &i : hives) {
		if (hive == i[0] || hive == i[1])
			return (HIVE)(&i - hives);
	}
	return HIVE::NUM;
}

HKEY hive_to_hkey(HIVE hive) {
	return (HKEY)intptr_t(0x80000000 + (int)hive);
}

enum class OPT : uint8_t {
//string options
	key			= 0,
	value,
	file,
	type,
	data,
	separator,
	machine,

//bool options
	all_subkeys	= 0,
	all_values,
	def_value,
	numeric_type,
	keys_only,
	data_only,
	case_sensitive,
	exact,
	force,
	view32,
	view64,

//flags
	alternative	= 1 << 6,

	end			= 0xff,
};
auto constexpr operator|(OPT a, OPT b) 	{ return OPT(uint8_t(a) | uint8_t(b)); }
auto constexpr operator&(OPT a, OPT b)	{ return bool(uint8_t(a) & uint8_t(b)); }

struct Option {
	OPT		opt;
	const wchar_t	*sw, *arg, *desc;
};

struct OPOptions {
	Option	*opts;
};

#define opt_end		{OPT::end,		nullptr, nullptr, nullptr}
#define opt_key		{OPT::key,		nullptr,	L"KeyName",	L"[\\\\Machine\\]FullKey\nMachine - Name of remote machine, omitting defaults to the current machine. Only HKLM and HKU are available on remote machines\nFullKey - in the form of ROOTKEY\\SubKey name\nROOTKEY - [ HKLM | HKCU | HKCR | HKU | HKCC ]\nSubKey  - The full name of a registry key under the selected ROOTKEY\n"}
#define opt_reg32	{OPT::view32,	L"reg:32",	nullptr,	L"Specifies the key should be accessed using the 32-bit registry view."}
#define opt_reg64	{OPT::view64|OPT::alternative,	L"reg:64",	nullptr,	L"Specifies the key should be accessed using the 64-bit registry view."}

static const OPOptions op_options[] = {
//QUERY,
{(Option[]){
	opt_key,
	{OPT::value,		L"v",	 	L"ValueName",	L"Queries for a specific registry key values.\nIf omitted, all values for the key are queried.\nArgument to this switch can be optional only when specified along with /f switch. This specifies to search in valuenames only."},
	{OPT::def_value|OPT::alternative,	L"ve",		nullptr,		L"Queries for the default value or empty value name (Default)."},
	{OPT::all_subkeys,	L"s",	 	nullptr,		L"Queries all subkeys and values recursively (like dir /s)."},
	{OPT::data,			L"f",	 	L"Data",		L"Specifies the data or pattern to search for.\nUse double quotes if a string contains spaces. Default is \"*\"."},
	{OPT::keys_only,	L"k",	 	nullptr,		L"Specifies to search in key names only."},
	{OPT::data_only,	L"d",	 	nullptr,		L"Specifies the search in data only."},
	{OPT::case_sensitive,L"c",	 	nullptr,		L"Specifies that the search is case sensitive.\nThe default search is case insensitive."},
	{OPT::exact,		L"e",	 	nullptr,		L"Specifies to return only exact matches.\nBy default all the matches are returned."},
	{OPT::type,			L"t",	 	L"Type",		L"Specifies registry value data type.\nValid types are:\nREG_SZ, REG_MULTI_SZ, REG_EXPAND_SZ, REG_DWORD, REG_QWORD, REG_BINARY, REG_NONE\nDefaults to all types."},
	{OPT::numeric_type,	L"z",	 	nullptr,		L"Verbose: Shows the numeric equivalent for the type of the valuename."},
	{OPT::separator,	L"se",		L"Separator",	L"Specifies the separator (length of 1 character only) in data string for REG_MULTI_SZ. Defaults to \"\\0\" as the separator."},
	opt_reg32,
	opt_reg64,
	opt_end
}},
//ADD,
{(Option[]){
	opt_key,
	{OPT::value,		L"v",		L"ValueName",	L"The value name, under the selected Key, to add."},
	{OPT::def_value|OPT::alternative,	L"ve",		nullptr,		L"adds an empty value name (Default) for the key."},
	{OPT::type,			L"t",	 	L"Type",		L"RegKey data types\n[ REG_SZ | REG_MULTI_SZ | REG_EXPAND_SZ | REG_DWORD | REG_QWORD | REG_BINARY | REG_NONE ]\nIf omitted, REG_SZ is assumed."},
	{OPT::separator,	L"s",	 	L"Separator",	L"Specify one character that you use as the separator in your data string for REG_MULTI_SZ. If omitted, use \"\\0\" as the separator."},
	{OPT::data,			L"d",	 	L"Data",		L"The data to assign to the registry ValueName being added."},
	{OPT::force,		L"f",	 	nullptr,		L"Force overwriting the existing registry entry without prompt."},
	opt_reg32,
	opt_reg64,
	opt_end
}},
//DEL,
{(Option[]){
	opt_key,
	{OPT::value,		L"v",		L"ValueName",	L"The value name, under the selected Key, to delete."},
	{OPT::def_value|OPT::alternative,	L"ve",		nullptr,		L"delete the value of empty value name (Default)."},
	{OPT::all_values|OPT::alternative,	L"va",		nullptr,		L"delete all values under this key."},
	{OPT::force,		L"f",	 	nullptr,		L"Forces the deletion without prompt."},
	opt_reg32,
	opt_reg64,
	opt_end
}},
//EXPORT,
{(Option[]){
	opt_key,
	{OPT::file,			nullptr,	L"FileName",	L"The name of the disk file to export."},
	{OPT::force,		L"y",	 	nullptr,		L"Force overwriting the existing file without prompt."},
	opt_reg32,
	opt_reg64,
	opt_end
}},
//IMPORT
{(Option[]){
	{OPT::file,			nullptr, 	L"FileName",	L"The name of the disk file to import."},
	{OPT::machine,		L"machine",	L"Machine",	    L"The name of the machine to import to."},
	opt_reg32,
	opt_reg64,
	opt_end
}},
//LOAD
{(Option[]){
	opt_key,
	{OPT::file,			nullptr, 	L"FileName",	L"The name of the hive file to load. You must use REG SAVE to create this file."},
	opt_reg32,
	opt_reg64,
	opt_end
}},
//UNLOAD
{(Option[]){
	opt_key,
	opt_end
}},
};

wchar_t *get_options(Option *opts, int argc, wchar_t *argv[], wchar_t **string_args, uint32_t &bool_args) {
	auto arge = argv + argc;
	while (argv < arge) {
		auto a = *argv++;
		if (!opts->sw) {
			if (a[0] == '/')
				return a;
			string_args[(int)opts++->opt] = a;
			continue;
		}

		if (a[0] == '/') {
			bool found = false;
			for (auto o = opts; o->desc; ++o) {
				if (wcscmp(a + 1, o->sw) == 0) {
					if (o->arg) {
						string_args[(int)o->opt] = (*argv)[0] == '/' ? (wchar_t*)L"" : *argv++;
					} else
						bool_args |= 1 << (int)o->opt;
					found = true;
					break;
				}
			}
			if (!found)
				return a;
		}
	}
	return nullptr;
}

void write_command_data(TextWriter<wchar_t> &out, BYTE *data, DWORD size, TYPE type, wchar_t *sep) {
	switch (type) {
		case TYPE::SZ:
		case TYPE::EXPAND_SZ: {
			auto text = string::view((const wchar_t*)data, size / 2);
			if (text.back() == 0)
				text.pop_back();
			out << text;
			break;
		}

		case TYPE::MULTI_SZ: {
			auto text = string::view((const wchar_t*)data, size / 2);
			if (text.back() == 0)
				text.pop_back();
			while (!text.empty()) {
				auto p = text.find(L'\0');
				out << string::view(text.begin(), p);
				if (p < text.end())
					++p;
				if (p < text.end())
					out << sep;
				text = string::view(p, text.end());
			}
			break;
		}
		case TYPE::DWORD:
			out << L"0x" << base<16>(*(DWORD*)data);
			break;

		case TYPE::DWORD_BIG_ENDIAN:
			out << L"0x" << base<16>(_byteswap_ulong(*(DWORD*)data));
			break;

		case TYPE::QWORD:
			out << L"0x" << base<16>(*(uint64_t*)data);
			break;

		default:
			for (int i = 0; i < size; i++) {
				auto b = data[i];
				out << base<16,2,'A'>(b);
			}
			break;
	}
}

size_t parse_command_data(wchar_t *data, TYPE type, char separator) {
	switch (type) {
		case TYPE::NONE:
		case TYPE::SZ:
		case TYPE::EXPAND_SZ:
		case TYPE::MULTI_SZ:
			return unescape(data, data, separator) * 2 + 2;

		case TYPE::DWORD:
			*(DWORD*)data = wcstol(data, nullptr, 10);
			return 4;

		case TYPE::QWORD:
			*(uint64_t*)data = wcstoll(data, nullptr, 10);
			return 8;

		case TYPE::BINARY: {
			BYTE *d = (BYTE*)data;
			for (const wchar_t *p = data; ; p++) {
				auto d0 = hexchar(p[0]);
				auto d1 = hexchar(p[1]);
				if (d0 >= 0 && d1 >= 0)
					*d++ = (d0 << 4) | d1;
				p += 2;
			}
			return d - (BYTE*)data;
		}
		default:
			return 0;
	}
}

void write_reg_data(FileWriter &out, BYTE *data, DWORD size, TYPE type) {
	switch (type) {
		case TYPE::SZ: {
			auto p = (wchar_t*)malloc(size * 2);
			escape(string::view((const wchar_t*)data, size / 2 - 1), p);
			out << L'"' << p << L'"' << endl; 
			free(p);
			break;
		}
		case TYPE::DWORD:
//			out << "dword:" << std::setfill(L'0') << std::setw(8) << std::hex << *(DWORD*)data << std::dec << endl;
			out << L"dword:" << base<16, 8>(*(DWORD*)data) << endl;
			break;

		//case TYPE::QWORD:
		//	out << "qword:" << std::hex << *(uint64_t*)data << std::dec << endl;
		//	break;

		default:
			if (type == TYPE::BINARY)
				out << L"hex:";
			else
				out << L"hex(" << base<16>((int)type) << L"):";

			for (int i = 0; i < size; i++) {
				auto b = data[i];
				out << base<16,2>(b);
				if (i != size - 1) {
					out << L',';
					if (out.column > 76)
						out << L'\\' << endl << L"  ";
				}
			}
			out << endl;
			break;
	}
}

dynamic_range<byte> parse_reg_data(const string &line, TYPE &type) {
	dynamic_range<byte>	data;

	if (line[0] == '"') {
		auto end = line.find_last('"');
		if (end) {
			type = TYPE::SZ;
			auto size = unescape(string::view(line.begin() + 1, end), (wchar_t*)data.ensure((end - line) * 2)) * 2 + 2;
			data.alloc(size);
		}

	} else if (line.startsWith(L"dword:")) {
		type = TYPE::DWORD;
		*((DWORD*)data.alloc(sizeof(DWORD))) = wcstoul(&line[6], nullptr, 16);

	} else if (line.startsWith(L"qword:")) {
		type = TYPE::QWORD;
		*((uint64_t*)data.alloc(sizeof(uint64_t))) = wcstoull(&line[6], nullptr, 16);

	} else if (line.startsWith(L"hex")) {
		auto p = &line[3];
	 	type = TYPE::BINARY;

		if (p[0] == '(') {
			type = (TYPE)wcstoul(p + 1, (wchar_t**)&p, 16);
			++p;
		}

		if (p[0] == ':')
			p++;

		for (;;) {
			wchar_t	*p2;
			auto v = wcstoul(p, &p2, 16);
			if (p == p2)
				break;
			*data.alloc(1) = v;
			p 		= p2;
			if (*p == ',')
				++p;
		}
	}
	return data;
}

//-----------------------------------------------------------------------------
//	RegKey
//-----------------------------------------------------------------------------

struct RegKey {
	struct Info {
		wchar_t	class_name[MAX_PATH] = L"";		// buffer for class name 
		DWORD	num_subkeys = 0;				// number of subkeys 
		DWORD	max_subkey	= 0;				// longest subkey size 
		DWORD	max_class 	= 0;				// longest class string 
		DWORD	num_values 	= 0;				// number of values for key 
		DWORD	max_value 	= 0;				// longest value name 
		DWORD	max_data 	= 0;				// longest value data 
		DWORD	cbSecurityDescriptor = 0; 		// size of security descriptor 
		FILETIME last_write;					// last write time 

		Info(HKEY h) {
			DWORD	class_size = MAX_PATH;		// size of class string 
			::RegQueryInfoKey(
				h,								// key handle 
				class_name,						// buffer for class name 
				&class_size,					// size of class string 
				NULL,							// reserved 
				&num_subkeys,					// number of subkeys 
				&max_subkey,					// longest subkey size 
				&max_class,						// longest class string 
				&num_values,					// number of values for this key 
				&max_value,						// longest value name 
				&max_data,						// longest value data 
				&cbSecurityDescriptor,			// security descriptor 
				&last_write			 			// last write time 
			);
		}
	};
	struct Value {
		string	name;
		TYPE	type	= TYPE::NONE;
		DWORD 	size	= 0;

		Value(const wchar_t *name = L"", TYPE type = TYPE::NONE, DWORD size = 0) : name(name), type(type), size(size) {}
		explicit constexpr operator bool() const { return size; }
	};


	HKEY h = nullptr;

	RegKey(HKEY h = nullptr)	: h(h) {}
	RegKey(RegKey &&b) 			: h(b.h) { b.h = nullptr; }
	RegKey(const wchar_t *k, REGSAM sam = KEY_READ) {
		auto	subkey	= wcschr(k, '\\');
		auto 	hive	= get_hive(subkey ? string(k, subkey - k) : string(k));
		auto 	ret = ::RegOpenKeyEx(hive_to_hkey(hive), subkey + !!subkey, 0, sam, &h);
		if (ret != ERROR_SUCCESS)
			h = nullptr;
	}
	RegKey(HKEY hParent, const wchar_t *subkey, REGSAM sam = KEY_READ) {
		auto ret = ::RegOpenKeyEx(hParent, subkey, 0, sam, &h);
		if (ret != ERROR_SUCCESS)
			h = nullptr;
	}
	~RegKey() { if (h) ::RegCloseKey(h); }

	RegKey& operator=(RegKey &&b) { swap(h, b.h); return *this; }

	operator HKEY()		const { return h; }
	auto info() 		const { return Info(h); }

	auto value(int i, BYTE *data, DWORD data_size) const {
		wchar_t	name[MAX_VALUE_NAME];
		DWORD 	name_size 	= MAX_VALUE_NAME;
		DWORD	type		= 0;
		auto 	ret		= ::RegEnumValue(h, i, name, &name_size, NULL, &type, data, &data_size);
		return ret == ERROR_SUCCESS
			? Value(name, (TYPE)type, data_size)
			: Value();
	}

	auto value(const wchar_t *name, BYTE *data, DWORD data_size) const {
		DWORD	type		= 0;
		auto 	ret		= ::RegQueryValueEx(h, name, 0, &type, data, &data_size);
		return ret == ERROR_SUCCESS
			? Value(name, (TYPE)type, data_size)
			: Value();
	}

	auto subkey(int i) const {
		wchar_t	name[MAX_KEY_LENGTH];
		DWORD 	name_size	= MAX_KEY_LENGTH;
		auto 	ret			= ::RegEnumKeyEx(h, i,
			name, &name_size, NULL,
			NULL, NULL,	//class
			NULL//&ftLastWriteTime
		);
		return ret == ERROR_SUCCESS ? string(name) : string();
	}

	auto set_value(const wchar_t *name, TYPE type, BYTE *data, DWORD size) {
		return ::RegSetValueEx(h, name, 0, (int)type, data, size);
	}

	auto remove_value(const wchar_t *name) {
		return ::RegDeleteValue(h, name);
	}
};

//-----------------------------------------------------------------------------
//	Reg
//-----------------------------------------------------------------------------

struct ParsedKey {
	string	host;
	HIVE	hive;
	string	subkey;

	ParsedKey(string::view k) {
		auto p = k.begin();
		if (p[0] == '\\' && p[1] == '\\') {
			auto a = p + 2;
			p 		= wcschr(a, '\\');
			host	= string(a, p++);
		}

		auto a	= p;
		p		= wcschr(p, '\\');
		if (p)
			subkey = string(p + 1, k.end());
		else
			p = k.end();

		hive	= get_hive(string(a, p).toupper());
	}

	HKEY get_rootkey() {
		auto h = hive_to_hkey(hive);
		if (!host.empty()) {
			auto ret = RegConnectRegistry(host, h, &h);
			if (ret != ERROR_SUCCESS)
				return nullptr;
		}
		return h;
	}
	auto get_keyname() {
		string	key = hives[(int)hive][0];
		return subkey ? key + L'\\' + subkey : key;
	}

	auto open_key(REGSAM sam, HKEY *h) {
		return RegOpenKeyEx(get_rootkey(), subkey, 0, sam, h);
	}
	auto delete_key(REGSAM sam) {
		return RegDeleteKeyEx(get_rootkey(), subkey, sam, 0);
	}
	auto create_key(REGSAM sam, HKEY *h) {
		return RegCreateKeyEx(get_rootkey(), subkey, 0, NULL, REG_OPTION_NON_VOLATILE, sam, NULL, h, NULL);
	}
};

struct Reg {
	union {
		wchar_t *string_args[7] = {nullptr};
		struct {
			wchar_t *key, *value, *file, *type, *data, *sep, *machine;
		};
	};

	union {
		uint32_t	bool_args	= 0;
		struct {
			bool all_subkeys 		: 1;
			bool all_values 		: 1;
			bool def_value 			: 1;
			bool numeric_type 		: 1;
			bool keys_only			: 1;
			bool data_only			: 1;
			bool case_sensitive		: 1;
			bool exact	 			: 1;
			bool force 	 			: 1;
			bool view32 			: 1;
			bool view64 			: 1;
		};
	};
	bool	values_only	= false;
	TYPE	types_only	= TYPE::NUM;
	wchar_t separator	= L'\0';

	int		found_keys	= 0, found_values = 0, found_data = 0;

	REGSAM	get_sam() const {
		REGSAM	sam = 0;
		if (view32)
			sam |= KEY_WOW64_32KEY;
		else if (view64)
			sam |= KEY_WOW64_64KEY;
		return sam;
	}

	bool check_value(const string &name) {
		return !value || !value[0] || wildcard_check((case_sensitive ? name : name.tolower()), value, true);
	}
	bool check_data(const string &name) {
		return exact
			? (case_sensitive ? name : name.tolower()) == data
			: wildcard_check((case_sensitive ? name : name.tolower()), data);

	}
	void query(const RegKey &r, string keyname, bool print_key);


	int doQUERY();
	int doADD();
	int doDELETE();
	int doEXPORT();
	int doIMPORT();
//	int doCOPY()	{ return 0; }
//	int doSAVE()	{ return 0; }
//	int doRESTORE() { return 0; }
	int doLOAD();
	int doUNLOAD();
//	int doCOMPARE() { return 0; }
//	int doFLAGS()	{ return 0; }
};

//-----------------------------------------------------------------------------
// query
//-----------------------------------------------------------------------------

void Reg::query(const RegKey &r, string keyname, bool printed_key) {
	auto info 		= r.info();
	auto tab		= L"	";
	auto space		= (BYTE*)malloc(info.max_data + 1);

	// Enumerate the values
	if (!data || data_only || values_only) {
		for (int i = 0; i < info.num_values; i++) {
			if (auto value = r.value(i, space, info.max_data)) {
				if (!check_value(value.name))
					continue;

				if (types_only != TYPE::NUM && value.type != types_only)
					continue;

				bool values_pass	= !values_only || check_data(value.name);

				string	data_string;
				if (data_only || values_pass) {
					StringBuilder	b(data_string);
					write_command_data(b, space, value.size, value.type, sep);
				}

				bool data_pass		= !data_only || check_data(data_string);
				
				if (values_only && data_only ? values_pass || data_pass : values_pass && data_pass) {
					found_values	+= values_pass;
					found_data		+= data_pass;

					if (!printed_key) {
						out << keyname << endl;
						printed_key = true;
					}

					out << tab;
					if (value.name.length())
						out << value.name;
					else
						out << L"(Default)";
					out << tab << types[value.type < TYPE::NUM ? (int)value.type : 0];

					if (numeric_type)
						out << L" (" << (int)value.type << L')';

					out << tab << data_string << endl;
				}
			}
		}

		if (printed_key)
			out << endl;
	}

	free(space);

	// Enumerate the subkeys
	for (int i = 0; i < info.num_subkeys; i++) {
		auto name = r.subkey(i);
		if (name.length()) {
			auto check = !keys_only || check_data(name);
			if (check) {
				out << keyname << L'\\' << name << endl;
				++found_keys;
			}
			if (all_subkeys)
				query(RegKey(r, name, KEY_READ | get_sam()), keyname + L"\\" + name, check);
		}
	}
}

int Reg::doQUERY() {
	ParsedKey	parsed(key);
	HKEY		h;
	if (auto ret = parsed.open_key(KEY_READ | get_sam(), &h))
		return ret;

	if (!case_sensitive) {
		if (data) {
			for (auto p = data; *p; ++p)
				*p = tolower(*p);
		}
		if (value) {
			for (auto p = value; *p; ++p)
				*p = tolower(*p);
		}
	}

	if (!sep)
		sep = (wchar_t*)L"\\0";

	values_only = value && !*value;
	if (data && !values_only && !data_only && !keys_only)
		data_only = keys_only = values_only = true;	//now they mean 'as well'


	types_only = type ? get_type(type) : TYPE::NUM;

	query(RegKey(h), parsed.get_keyname(), false);

	if (data) {
		out << L"End of search: ";
		if (keys_only)
			out << found_keys << L" key(s)";
		if (values_only)
			out << onlyif(keys_only, L", ") << found_values << L" item(s)";
		if (data_only)
			out << onlyif(keys_only || values_only, L", ") << found_data << L" values(s)";
		out << L" found.";
	}
	return 0;
}

//-----------------------------------------------------------------------------
// add
//-----------------------------------------------------------------------------

int Reg::doADD() {
    //waitDebugger();

	ParsedKey	parsed(key);
	auto 		access = KEY_ALL_ACCESS | get_sam();
	HKEY		h;

	auto ret = parsed.create_key(access, &h);
	if (ret != ERROR_SUCCESS || (!value && !def_value))
		return ret;

	wchar_t separator = L'\0';
	if (sep) {
		if (unescape(sep, sep) != 1)
			return ERROR_INVALID_FUNCTION;//bad sep
		separator = sep[0];
	}{}

	TYPE	itype = get_type(type);
	if (itype == TYPE::NUM)
		return 1;

	DWORD	size = parse_command_data(data, itype, separator);
	RegKey	r(h);
	return r.set_value(value, itype, (BYTE*)data, size);
}

//-----------------------------------------------------------------------------
// delete
//-----------------------------------------------------------------------------

int Reg::doDELETE() {
	ParsedKey	parsed(key);
	auto 		access = KEY_ALL_ACCESS | get_sam();

	if (!value && !def_value && !all_values)
		return parsed.delete_key(access);

	HKEY		h;
	if (auto ret = parsed.open_key(access, &h))
		return ret;

	RegKey		r(h);

	if (all_values) {
		auto 	info	= r.info();
		for (int i = 0; i < info.num_values; i++) {
			if (auto value = r.value(i, nullptr, 0)) {
				if (auto ret = r.remove_value(value.name))
					return ret;
			}
		}
		return 0;
	}

	return r.remove_value(value);
}

//-----------------------------------------------------------------------------
// import
//-----------------------------------------------------------------------------

auto win_getline(FileReader &reader) {
	auto line = string::read_to(reader, '\n');
	if (line.back() == '\r')
		line.pop_back();
	return line;
}

int Reg::doIMPORT() {
	FileReader	reader(file);
	if (!reader) {
		out << L"Failed to open file: " << file << endl;
		return errno;
	}

//	stream.imbue(std::locale(std::locale(), new std::codecvt_utf16<wchar_t, 0x10FFFF, std::consume_header>));

	string line, line2;
	line = win_getline(reader);
	if (line != L"Windows Registry Editor Version 5.00")
		return 1;

	RegKey	key;
	auto 	access = KEY_ALL_ACCESS | get_sam();
	bool 	deleted = false;
	HKEY	h;

	// Parse key values and subkeys
	while (!reader.eof()) {
        line = win_getline(reader).trim();
		if (!line.empty() && line[0] != ';') {
			bool	more = line.back() == '\\';
			if (more) {
				line.pop_back();
				for (StringBuilder b(line); more;) {
					auto line2 = win_getline(reader);
					more = line2.back() == '\\';
					if (more)
						line2.pop_back();
					b << line2;
				}
			}

			if (line[0] == '[') {
				deleted = line[1] == '-';
				auto	open	= 1 + deleted;
				auto	close	= line.find_first(']');
				ParsedKey	parsed(string::view(line.begin() + open, close));
                parsed.host = string(machine);

				if (deleted) {
					if (auto ret = parsed.delete_key(access))
						return ret;

				} else {
					if (auto ret = parsed.open_key(access, &h))
						return ret;
					key = RegKey(h);
				}

			} else if (!deleted) {
				auto 	equals	= line.find_first('=');
				if (equals) {
					auto	name 	= string::view(line.begin(), equals).trim();
					auto	value	= string::view(equals + 1).trim();

					if (name[0] == '"' && name.back() == '"')
						name = string::view(name.begin() + 1, name.end() - 1);

					if (value == L"-") {
						key.remove_value(string(name));

					} else {
						TYPE	type;
						auto	data	= parse_reg_data(string(value), type);
						if (data.size() > 0) {	//ignore bad data
							if (auto ret = key.set_value(string(name), type, data.a, data.p - data.a))
								return ret;
						}
					}
				}
			}
		}
	}

	return 0;
}

//-----------------------------------------------------------------------------
// export
//-----------------------------------------------------------------------------

void export_recurse(FileWriter &out, const RegKey &key, string keyname) {
	out << L'[' << keyname << L']' << endl;

	auto info 	= key.info();
	auto data	= (BYTE*)malloc(info.max_data + 1);

	// Enumerate the values
	for (int i = 0; i < info.num_values; i++) {
		if (auto value = key.value(i, data, info.max_data)) {
			if (value.name.length())
				out << L'"' << value.name << L'"';
			else
				out << L'@';
			out << L'=';

			write_reg_data(out, data, value.size, value.type);
		}
	}
	free(data);

	out << endl;

	// Enumerate the subkeys
	for (int i = 0; i < info.num_subkeys; i++) {
		auto name = key.subkey(i);
		if (name.length())
			export_recurse(out, RegKey(key.h, name), keyname + L'\\' + name);
	}
}

int Reg::doEXPORT() {
//	 std::wofstream stream(file, std::ios_base::binary|std::ios_base::out);
	FileWriter	stream(file);
	if (!stream) {
		out << L"Failed to create file: " << file << endl;
		return errno;
	}

	//stream.imbue(std::locale(std::locale(), new std::codecvt_utf16<wchar_t, 0x10ffff, std::little_endian>));

	//stream << L'\xfeff';	//BOM
	stream << L"Windows Registry Editor Version 5.00" << endl << endl;

	ParsedKey	parsed(key);
	HKEY h;
	if (auto ret = parsed.open_key(KEY_READ | get_sam(), &h))
		return ret;

	export_recurse(stream, h, parsed.get_keyname());
	return 0;
}

//-----------------------------------------------------------------------------
// load/unload
//-----------------------------------------------------------------------------

int Reg::doLOAD()	{
	ParsedKey	parsed(key);
#if 0
	return RegLoadKey(parsed.get_rootkey(), parsed.subkey, file);
#else
	HKEY	h;
	if (auto ret = RegLoadAppKey(file, &h, KEY_ALL_ACCESS | get_sam(), 0, 0))
		return ret;
	out << L"Loaded: " << parsed.get_keyname() << L"=" << h << endl;
	return 0;
#endif
}

int Reg::doUNLOAD()	{
	ParsedKey	parsed(key);
	return RegUnLoadKey(parsed.get_rootkey(), parsed.subkey);
}

//-----------------------------------------------------------------------------
//	main
//-----------------------------------------------------------------------------

void print_options(OP op) {
	out << L"REG " << ops[(uint8_t)op];
	bool	optional = false;
	for (auto opt = op_options[(uint8_t)op].opts; opt->desc; ++opt) {
		if ((opt->opt & OPT::alternative)) {
			out << L" | ";
		} else {
			if (optional)
				out << L']';
			out << L' ';
			optional = !!opt->sw;
			if (optional)
				out << L'[';
		}

		if (opt->sw) {
			out << L'/' << opt->sw;
			if (opt->arg)
				out << L' ';
		}
		if (opt->arg)
			out << opt->arg;
	}
	if (optional)
		out << L']';
	out << endl;

	for (auto opt = op_options[(uint8_t)op].opts; opt->desc; ++opt) {
		out << L"  ";
		if (opt->sw) {
			out << L'/' << opt->sw;
		} else if (opt->arg) {
			out << opt->arg;
		}
		auto desc = opt->desc;
		while (auto p = wcschr(desc, '\n')) {
			out << L'\t' << string(desc, p + 1);
			desc = p + 1;
		}
		out << L'\t' << desc << endl;
	}
}

int wmain(int argc, wchar_t* argv[]) {
	_setmode(_fileno(stdout), _O_U8TEXT);

    //waitDebugger();

	if (argc < 2) {
		out << L"** NOTE: this is an unofficial replacement for REG **" << endl << endl
			<< L"REG Operation [Parameter List]" << endl << endl
			<< L"Operation  [ QUERY | ADD | DELETE | EXPORT | IMPORT]" << endl << endl
			<< L"Returns WINERROR code (e.g ERROR_SUCCESS = 0 on sucess)" << endl << endl
			<< L"For help on a specific operation type:" << endl << endl
			<< L"REG Operation /?" << endl << endl;
		return 0;
	}

	OP op = get_op(argv[1]);
	if (op == OP::NUM) {
		out << L"Unknown operation: " << argv[1] << endl;
		return ERROR_INVALID_FUNCTION;
	}

	if (argv[2] == L"/?"_s) {
		print_options(op);
		return 0;
	}

	Reg reg;
	auto err = get_options(op_options[(uint8_t)op].opts, argc - 2, argv + 2, reg.string_args, reg.bool_args);
	if (err) {
		out << L"Unknown option: " << err << endl;
		return ERROR_INVALID_FUNCTION;
	}

	int r = 0;
	switch (op) {
		case OP::QUERY: 	r = reg.doQUERY(); 	break;
		case OP::ADD: 		r = reg.doADD();	break;
		case OP::DEL: 		r = reg.doDELETE();	break;
		case OP::EXPORT: 	r = reg.doEXPORT(); break;
		case OP::IMPORT: 	r = reg.doIMPORT(); break;
	//	case OP::COPY: 		r = reg.doCOPY();	break;
	//	case OP::SAVE: 		r = reg.doSAVE();	break;
	//	case OP::RESTORE: 	r = reg.doRESTORE();break;
		case OP::LOAD: 		r = reg.doLOAD();	break;
		case OP::UNLOAD: 	r = reg.doUNLOAD(); break;
	//	case OP::COMPARE: 	r = reg.doCOMPARE();break;
	//	case OP::FLAGS: 	r = reg.doFLAGS();	break;
		default: break;
	}
	switch (r) {
		case ERROR_SUCCESS:
			break;
		case ERROR_FILE_NOT_FOUND:
			out << L"ERROR: File not found" << endl;
			break;
		case ERROR_ACCESS_DENIED:
			out << L"ERROR: Access denied" << endl;
			break;
		default: {
			out << L"ERROR " << r << L": ";
			wchar_t *buffer;
			FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM|FORMAT_MESSAGE_ALLOCATE_BUFFER, nullptr, r, 0, (LPWSTR)&buffer, 0, nullptr);
			out << buffer << endl;
			break;
		}
	}
	return r;
}
