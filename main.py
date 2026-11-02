from dotenv import load_dotenv
from sqlalchemy import create_engine,String,Column,Integer,text
from sqlalchemy.orm import DeclarativeBase,sessionmaker
import os
load_dotenv()
DataBase_url = os.getenv("database_url")
print(DataBase_url)

# creating engine
engine = create_engine(DataBase_url)
with engine.connect() as conn:
  version = conn.execute(text("SELECT version()")).scalar()
  


# creating session local
SessionLocal = sessionmaker(bind=engine)
db = SessionLocal()


# creating Base Class
class Base(DeclarativeBase):
  pass

class StudentDB(Base):
  __tablename__ = "students_record"
  id = Column(String, primary_key=True )
  name = Column(String(50), nullable=False )
  age = Column(Integer,nullable=False)
  course = Column(String,nullable=False) 
  marks = Column(Integer,nullable=False)
  email = Column(String,unique=True,nullable=False)

Base.metadata.create_all(bind=engine)
print("table ready...")

# pydantic schemas for input
from pydantic import BaseModel,EmailStr,Field,field_validator,computed_field,ConfigDict
from fastapi import HTTPException
class StudentCreate(BaseModel):
  id: str = Field(...,description="enter student id")
  name: str = Field(...,description="enter your name")
  age: int = Field(...,gt=0,lt=120)
  course: str = Field(...,max_length=20)
  marks: int = Field(...,ge=0,le=100)
  email: EmailStr 

  @field_validator("name")
  @classmethod
  def check_name(cls,value):
    if not value.replace(" ","").isalpha():
      raise ValueError("name must contains alphabet and spaces")
    return value.title()


class StudentUpdate(BaseModel):
  name: str|None = Field(None,description="enter your name")
  age: int| None = Field(None,gt=0,lt=120)
  course: str| None = Field(None,max_length=20)
  marks: int| None = Field(None,ge=0,le=100)
  email: EmailStr  |None=None
  
  @field_validator("name")
  @classmethod
  def check_name(cls,value):
    if not value.replace(" ","").isalpha():
      raise ValueError("name must contains alphabet and spaces")
    return value.title()
  

  #  pydantic schemas for output
class StudentResponse(StudentCreate):
  model_config = ConfigDict(from_attributes=True) # from_attribute=True let pydantic to read student.marks(object)
  @computed_field
  @property
  def grade(self) -> str:
    if self.marks>=90:
      return "A+"
    elif self.marks>=80:
      return "A"
    elif self.marks>=70:
      return "B+"
    elif self.marks>=60:
      return "B"
    elif self.marks>=50:
      return "C+"
    elif self.marks>=40:
      return "c"
    else:
      return "Fail"
  # get_db one session per request
  # open the session pause at yeild while endpoint does it work and then finally close it
def get_db():
  db = SessionLocal()
  try:
    yield db
  finally:
    db.close()

# creating the app
from fastapi import FastAPI,Path,Depends,Query
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from sqlalchemy import func
app = FastAPI()

# get one student
# Depends(get_db) means: before running this end point run the get_db function and give what it returns
@app.get("/student/{student_id}",response_model=StudentResponse)
def get_student(student_id:str=Path(...,description="the id of the student"),db:Session=Depends(get_db)):
  student =  db.get(StudentDB,student_id)
  if student is None:
    raise HTTPException(status_code=404,detail=f"student with the id '{student_id}' not found ")
  return student

# for creating the student
@app.post("/create_student",response_model=StudentResponse,status_code=201)
def create_student(student:StudentCreate,db:Session= Depends(get_db)):
  if db.get(StudentDB,student.id) :
    raise HTTPException(status_code=400,detail=f"student with id '{student.id}' already exists.")

  new_student = StudentDB(**student.model_dump())
  db.add(new_student)
  try:
    db.commit()
  except IntegrityError:
    db.rollback()
    raise HTTPException(status_code=400,detail=f"email with {student.email} is already use")
  db.refresh(new_student)
  return new_student

# for update the student
@app.put("/UpdateStudent/{student_id}")
def update_student(student_update:StudentUpdate,student_id:str=Path(...,description="the id of the student"),db:Session=Depends(get_db)):
  
  student = db.get(StudentDB,student_id)
  if student is None:
    raise HTTPException(status_code=404,detail=f"student with the id {student_id} do not exist")
  changes = student_update.model_dump(exclude_unset=True) #model_dump changes the class student which have data in json to dictionary
  for key,value in changes.items():
    setattr(student,key,value)
  try:
    db.commit()
  except IntegrityError:
    db.rollback()
    raise HTTPException(status_code=400,detail=f"email with {student.email} is already use")
  db.refresh(student)
  return student
  
# delete
@app.delete("/deletestudent/{student_id}")
def delete_student(student_id:str=Path(...,description="the id of the student"),db:Session=Depends(get_db)):
  student = db.get(StudentDB,student_id)
  if student is None:
    raise HTTPException(status_code=404,detail=f"student with the id {student_id} do not exist")
  db.delete(student)
  db.commit()
  return {"message":f"student of id {student_id} deleted successfully."}

# filter sort paginate
sort_field = ["age","marks","name"]
sort_order = ["asc","desc"]
@app.get("/students")
def get_all(course:str|None=Query(None,description="show only student in this course",example=["python"]),sort_by:str|None=Query(None,description="sort by age,marks,name"),order:str=Query("asc",description="asc or desc"),page:int=Query(1,ge=1,description="which page do you want (start from 1)"),limit:int=Query(2,ge=1,le=100,description="how many student on one page (1 to 100)"),db:Session=Depends(get_db)):
  if sort_by is not None and sort_by not in sort_field:
    raise HTTPException(status_code=400,detail=f"invalid {sort_by} choose from {sort_field}")
  if order not in sort_order:
    raise HTTPException(status_code=400,detail=f"invalid order {order} choose from {sort_order}")

  query=db.query(StudentDB)

  if course:
    query = query.filter(func.lower(StudentDB.course) == course.lower())

  total_student = query.count()

  if sort_by:
    column = getattr(StudentDB,sort_by)
    if order == "desc":
      query = query.order_by(column.desc())
    else:
      query = query.order_by(column.asc())
  
  else:
    query = query.order_by(StudentDB.id)

  start = (page-1)*limit
  student = query.offset(start).limit(limit).all()

  return {
    "page": page,
    "limit":limit,
    "total_students":total_student,
    "students":student

  }
