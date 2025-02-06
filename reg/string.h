#include "text.h"
#include <memory.h>
#include <stdlib.h>
#include <wchar.h>

//-----------------------------------------------------------------------------
//	string
//-----------------------------------------------------------------------------

enum class XX {};

template<typename C> inline C* string_alloc(int n) {
	auto p = (C*)malloc((n + 1) * sizeof(C));
	p[n] = 0;
	return p;
}

class string {
	wchar_t	*p;
public:
	struct view : range<const wchar_t*> {
		using range<const wchar_t*>::range;
		view(const wchar_t *s)	: view(s, string_length(s)) {}
		template<int N> view(const wchar_t (&s)[N])	: view(s, N) {}
		view 	substr(int i) 			const	{ return {a + i, b}; }
		view 	substr(int i, int j)	const	{ return {a + i, a + i + j}; }
		view 	trim()					const	{
			auto a = begin(), b = end();
            if (a) {
                while (is_whitespace(*a))
                    a++;
                while (b > a && is_whitespace(b[-1]))
                    --b;
            }
			return {a, b};
		}
		friend string operator+(const view &a, const view &b);
		friend string operator+(const view &a, wchar_t b);
	};

	static const auto pre_alloc = (XX)0;
	string(wchar_t *p, XX)		: p(p) {}

	string()	: p(nullptr) {}
	string(const wchar_t *s, size_t n)			: p(string_alloc<wchar_t>(n)) { copyn(p, s, n); }
	string(const wchar_t *a, const wchar_t *b)	: string(a, b - a) {}
	string(const wchar_t *s)					: string(s, string_length(s)) {}
	explicit string(view v)						: string(v.begin(), v.end())	{}
	string(const string &b)						: string(b.p)	{}
	string(string &&b)							: p(exchange(b.p, nullptr)) {}
	~string()						{ if (p) free(p); }

	string& operator=(string &&b)	{ swap(p, b.p); return *this; }
	string& operator=(view v)		{ return *this = string(v); }

	operator const wchar_t*()	const	{ return p; }
	operator view() 			const	{ return {p, length()}; }
	range<wchar_t*>	detach()			{ if (!p) return none; auto len = length(); return {exchange(p, nullptr), len + 1}; }	

	size_t	length()			const	{ return p ? string_length(p) : 0; }
	bool 	empty()				const 	{ return !p || !p[0]; }
	auto	begin()				const	{ return p; }
	auto	end()				const	{ return p + length(); }
	auto	back()				const	{ auto e = end(); return e ? e[-1] : 0; }
	auto& 	operator[](int i)	const 	{ return p[i]; }
	view 	substr(int a) 		const	{ return (operator view()).substr(a); }
	view 	substr(int a, int b)const	{ return (operator view()).substr(a, b); }
	view 	trim() 				const 	{ return (operator view()).trim(); }
	auto 	toupper() 			const&	{ return string(*this).toupper(); }
	auto 	tolower() 			const&	{ return string(*this).tolower(); }

	void	pop_back()		{ auto t = end(); t[-1] = 0; }

	string&& toupper() && {
		for (auto i = p; *i; ++i)
			*i = to_upper(*i);
		return static_cast<string&&>(*this);
	}
	string&& tolower() && {
		for (auto i = p; *i; ++i)
			*i = to_lower(*i);
		return static_cast<string&&>(*this);
	}

	wchar_t*	find_last(wchar_t c) const {
		for (auto t = end(); t-- != p; ) {
			if (*t == c)
				return t;
		}
		return nullptr;
	}
	wchar_t* 	find_first(wchar_t c)	const {
		for (auto t = p; *t; ++t) {
			if (*t == c)
				return t;
		}
		return nullptr;
	}

	string& operator+=(const view &b) {
		return *this = operator view() + b;
	}
	bool startsWith(const wchar_t *b) const {
		auto alen = length(), blen = string_length(b);
		return blen <= alen && string_compare(p, b, blen) == 0;
	}

	bool endsWith(const string &a, const wchar_t *b) {
		auto alen = length(), blen = string_length(b);
		return blen <= alen && string_compare(p + (alen - blen), b, blen) == 0;
	}

	friend bool operator==(const string &a, const wchar_t *b) 	{ return string_compare(a.p, b) == 0; }
	friend bool operator<=(const string &a, const wchar_t *b) 	{ return string_compare(a.p, b) <= 0; }
	friend bool operator< (const string &a, const wchar_t *b) 	{ return string_compare(a.p, b) < 0; }
	friend bool operator!=(const string &a, const wchar_t *b) 	{ return !(a == b); }
	friend bool operator>=(const string &a, const wchar_t *b) 	{ return !(a <  b); }
	friend bool operator> (const string &a, const wchar_t *b) 	{ return !(a <= b); }

	template<typename R> static string read_to(R &r, wchar_t terminator) {
		string  ret;
		wchar_t buffer[256];
		int	c;

		do {
			wchar_t *p = buffer;
			while ((c = r.getc()) >= 0 && c != terminator && p < ::end(buffer))
				*p++ = c;
			if (p == buffer)
				break;

			ret += view(buffer, p - buffer);
		} while (c >= 0 && c != terminator);

		return ret;
	}
};

auto operator""_s(const wchar_t* s, size_t n) { return string::view(s, n); }

bool operator==(const string::view &a, const string::view &b) {	return string_compare(a.a, b.a, a.size(), b.size()) == 0;}
bool operator<=(const string::view &a, const string::view &b) {	return string_compare(a.a, b.a, a.size(), b.size()) <= 0;}
bool operator< (const string::view &a, const string::view &b) {	return string_compare(a.a, b.a, a.size(), b.size()) <  0;}
bool operator!=(const string::view &a, const string::view &b) {	return !(a == b); }
bool operator>=(const string::view &a, const string::view &b) {	return !(a <  b); }
bool operator> (const string::view &a, const string::view &b) {	return !(a <= b); }

string operator+(const string::view &a, const string::view &b) {
	auto	p = string_alloc<wchar_t>(a.size() + b.size());
	copyn(p, a.begin(), a.size());
	copyn(p + a.size(), b.begin(), b.size());
	return {p, string::pre_alloc};
}

string operator+(const string::view &a, wchar_t b) {
	auto p = string_alloc<wchar_t>(a.size() + 1);
	copyn(p, a.begin(), a.size());
	p[a.size()] = b;
	return {p, string::pre_alloc};
}

inline TextWriter<wchar_t>& operator<<(TextWriter<wchar_t>& p, const string& t) {
	if (t)
		p.write(t.begin(), t.length());
	return p;
}

struct StringBuilder : TextWriter<wchar_t>, dynamic_range<wchar_t> {
	string	&s;

	StringBuilder(string &s) : s(s), dynamic_range<wchar_t>(s.detach()) { if (p) --p; }
	~StringBuilder() { if (p) *p = 0; s = string(detach(), string::pre_alloc); }

	size_t write(const wchar_t* buffer, size_t size) override {
		ensure(size + 1);
		copyn(p, buffer, size);
		p += size;
		return size;
	}
};

template<typename T> string& operator<<(string &s, const T& t) {
	StringBuilder	b(s);
	b << t;
	return s;
}

template<typename T> string& operator<<(string &&s, const T& t) {
	return s << t;
}
/*
struct StringReader : TextReader<wchar_t> {
	const wchar_t *p, *end;

	StringReader(const wchar_t* p, size_t len) : p(p), end(p + len) {}
	StringReader(const wchar_t* p) 	: StringReader(p, string_length(p)) {}
	StringReader(const string& s) 	: StringReader(s.begin(), s.length()) {}

	int 	peek() 		override { return p < end ? *p : -1; }
	size_t 	available() override { return size_t(end - p); }
	int 	read() 		override { return p < end ? *p++ : -1; }
};
*/