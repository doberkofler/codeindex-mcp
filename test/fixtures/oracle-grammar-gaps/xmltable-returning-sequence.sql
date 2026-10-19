select a
from   xmltable('/x' passing '<x/>' columns a number path 'a' returning sequence by ref);
/
